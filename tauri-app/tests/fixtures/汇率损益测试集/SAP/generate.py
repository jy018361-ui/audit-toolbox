# -*- coding: utf-8 -*-
"""
汇率损益测试集（SAP 导出风格）生成 + 自检脚本
================================================

虚构主体：森蓝精密部件（苏州）有限公司（SAP 公司代码 SLP，本位币 CNY）
会计期间：2026-01-01 至 2026-06-30（会计年度按日历年）
记账汇率：USD=7.12  EUR=7.83（HKD/JPY 见 README，本套数据未发生 HKD/JPY 业务）
期末汇率（2026-06-30）：USD=7.18  EUR=7.90

产出：
  SAP_科目余额表.xlsx —— FAGLLB03/S_ALR 风格总账余额清单（TB，按科目x币种一行）
  SAP_凭证明细.xlsx   —— FBL3N 风格总账行项目报表（JE）

预埋审计测试点（详见 README.md）：
  1. JE 的 Currency 列"只标外币"：本位币（CNY）行留空，仅 USD/EUR 行填值；
     TB 的 Currency 列每行都填（含 CNY）。两表币种列形态不同。
  2. 期末重估不完整：6 月底仅对 USD 货币性科目做了重估（660302 有 USD 重估凭证），
     EUR 货币性科目（100103、112203）漏重估。

运行：python generate.py
控制台输出为中文 + [PASS]/[FAIL]，无 emoji（Windows GBK 兼容）。
"""

import os
import sys
from collections import defaultdict
from datetime import date
from decimal import Decimal, ROUND_HALF_UP

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# ----------------------------------------------------------------------------
# 基础参数
# ----------------------------------------------------------------------------
ENTITY_CN = "森蓝精密部件（苏州）有限公司"
COMPANY_CODE = "SLP"
LOCAL_CURRENCY = "CNY"
PERIOD_FROM = date(2026, 1, 1)
PERIOD_TO = date(2026, 6, 30)

BOOK_RATES = {"USD": Decimal("7.12"), "EUR": Decimal("7.83")}
END_RATES = {"USD": Decimal("7.18"), "EUR": Decimal("7.90")}  # 2026-06-30

CENT = Decimal("0.01")


def d2(value):
    """按分位四舍五入。"""
    return Decimal(value).quantize(CENT, rounding=ROUND_HALF_UP)


# 货币性外币科目（参与期末重估的科目；费用/收入/存货/固定资产不参与）
MONETARY_ACCOUNTS = {"100102", "100103", "112202", "112203", "112302", "203002", "250101"}
# 预埋点 2 明确"漏重估"的 EUR 科目
EUR_MISSING_ACCOUNTS = {"100103", "112203"}

# ----------------------------------------------------------------------------
# 科目表（SAP 六位科目号 + 中英文名称）
# ----------------------------------------------------------------------------
ACCOUNTS = {
    "100101": "银行存款-工商银行园区支行(人民币户)",
    "100102": "银行存款-中国银行苏州分行(美元户)",
    "100103": "银行存款-中国银行苏州分行(欧元户)",
    "101101": "其他货币资金-信用证保证金(人民币)",
    "112101": "应收票据-国内客户",
    "112201": "应收账款-国内客户",
    "112202": "应收账款-美元客户",
    "112203": "应收账款-欧元客户",
    "112301": "其他应收款-员工备用金",
    "112302": "其他应收款-关联方往来(美元)",
    "112303": "其他应收款-应收出口退税",
    "123101": "坏账准备",
    "140101": "原材料-精密件用材",
    "140501": "库存商品-精密部件",
    "160101": "固定资产-机器设备",
    "160102": "固定资产-电子设备",
    "160201": "累计折旧",
    "200101": "短期借款-工商银行园区支行",
    "203001": "应付账款-国内供应商",
    "203002": "应付账款-美元供应商",
    "203003": "应付账款-费用类往来(国内)",
    "220201": "应付职工薪酬-工资",
    "220202": "应付职工薪酬-社保公积金",
    "224101": "其他应付款-代扣个人款项",
    "222101": "应交税费-应交增值税(销项税额)",
    "222102": "应交税费-未交增值税",
    "222103": "应交税费-应交增值税(进项税额)",
    "250101": "长期借款-股东借款(美元)",
    "400101": "实收资本-外方投入",
    "410301": "未分配利润(期初)",
    "600101": "主营业务收入-精密部件出口(美元)",
    "600102": "主营业务收入-国内销售",
    "600103": "主营业务收入-欧洲市场出口(欧元)",
    "640101": "主营业务成本",
    "660101": "销售费用-运输费",
    "660102": "销售费用-报关费",
    "660201": "管理费用-职工薪酬",
    "660202": "管理费用-折旧费",
    "660203": "管理费用-办公及水电费",
    "660301": "财务费用-利息支出",
    "660302": "财务费用-汇兑损益",
    "660303": "财务费用-手续费(美元账户)",
}

# 期初余额（2026-01-01），借方为正、贷方为负。
# 元素：(科目, 币种, 原币期初[借正贷负], 本位币期初[借正贷负])；CNY 行原币=本位币。
OPENING = [
    ("100101", "CNY", d2(8600000), d2(8600000)),
    ("100102", "USD", d2(500000), d2(3560000)),
    ("100103", "EUR", d2(120000), d2(939600)),
    ("101101", "CNY", d2(500000), d2(500000)),
    ("112101", "CNY", d2(460000), d2(460000)),
    ("112201", "CNY", d2(2350000), d2(2350000)),
    ("112202", "USD", d2(260000), d2(1851200)),
    ("112203", "EUR", d2(80000), d2(626400)),
    ("112301", "CNY", d2(120000), d2(120000)),
    ("112302", "USD", d2(90000), d2(640800)),
    ("123101", "CNY", d2(-235000), d2(-235000)),
    ("140101", "CNY", d2(3200000), d2(3200000)),
    ("140501", "CNY", d2(2780000), d2(2780000)),
    ("160101", "CNY", d2(12800000), d2(12800000)),
    ("160102", "CNY", d2(1650000), d2(1650000)),
    ("160201", "CNY", d2(-3450000), d2(-3450000)),
    ("200101", "CNY", d2(-3000000), d2(-3000000)),
    ("203001", "CNY", d2(-1960000), d2(-1960000)),
    ("203002", "USD", d2(-150000), d2(-1068000)),
    ("203003", "CNY", d2(-96500), d2(-96500)),
    ("220201", "CNY", d2(-380000), d2(-380000)),
    ("220202", "CNY", d2(-118000), d2(-118000)),
    ("224101", "CNY", d2(-61300), d2(-61300)),
    ("222101", "CNY", d2(-254000), d2(-254000)),
    ("250101", "USD", d2(-400000), d2(-2848000)),
    ("400101", "CNY", d2(-20000000), d2(-20000000)),
    # 410301 未分配利润为轧平项，下面自动计算
]

# ----------------------------------------------------------------------------
# 凭证构建
# ----------------------------------------------------------------------------
# 行结构：(科目, 币种(None=CNY 本位币行), 借贷 S/H, 原币金额(正数), 摘要, 本位币金额覆盖)
# 本位币金额缺省 = round(原币 x 记账汇率, 2)；CNY 行原币=本位币。
VOUCHERS = []
_DOC_SEQ = [0]
_USERS = itertools_user = {"n": 0}


def new_doc_no():
    _DOC_SEQ[0] += 1
    return "5100%06d" % _DOC_SEQ[0]


def add_voucher(dtype, pdate, lines, ref="", assign=None, user="SLPFI01", ddate=None):
    """登记一张凭证。lines 为行元组列表（结构见上）。"""
    _USERS["n"] += 1
    user = "SLPFI01" if _USERS["n"] % 3 else ("SLPFI02" if _USERS["n"] % 2 else "SLPBATCH")
    VOUCHERS.append({
        "no": new_doc_no(),
        "dtype": dtype,
        "pdate": pdate,
        "ddate": ddate or pdate,
        "ref": ref,
        "assign": assign or pdate.strftime("%Y-%m"),
        "user": user,
        "lines": lines,
    })


def md(month, day):
    return date(2026, month, day)


def last_day(month):
    return {1: 31, 2: 28, 3: 31, 4: 30, 5: 31, 6: 30}[month]


def calc_local(code, currency, orig):
    """按记账汇率折算本位币（Decimal，两位小数）。"""
    if currency is None or currency == "CNY":
        return d2(orig)
    return d2(Decimal(orig) * BOOK_RATES[currency])


# ---- 1. 美元出口销售（DR 客户发票） -----------------------------------------
USD_SALES = {1: [75000, 75000], 2: [130000], 3: [85000, 75000],
             4: [80000, 60000], 5: [90000, 80000], 6: [75000, 70000]}
for m, amounts in USD_SALES.items():
    for i, amt in enumerate(amounts):
        inv = "INV-US-%d%02d" % (m, i + 1)
        add_voucher("DR", md(m, 8 if i == 0 else 18), [
            ("112202", "USD", "S", d2(amt), "出口销售开票-美元客户 NextGen Robotics", None),
            ("600101", "USD", "H", d2(amt), "出口销售收入-精密部件 %s" % inv, None),
        ], ref=inv, assign="US-CUST-%03d" % (100 + m), ddate=md(m, 6 if i == 0 else 15))

# ---- 2. 欧元出口销售（DR） ---------------------------------------------------
for m in range(1, 7):
    inv = "INV-EU-%02d" % m
    add_voucher("DR", md(m, 12), [
        ("112203", "EUR", "S", d2(40000), "出口销售开票-欧元客户 Rheinwerk GmbH", None),
        ("600103", "EUR", "H", d2(40000), "出口销售收入-欧洲市场 %s" % inv, None),
    ], ref=inv, assign="EU-CUST-201", ddate=md(m, 10))

# ---- 3. 国内销售（DR，13% 销项税） ------------------------------------------
DOM_SALES = {1: [480000, 350000], 2: [1300000], 3: [510000, 330000],
             4: [1350000], 5: [490000, 360000], 6: [520000, 410000]}
for m, nets in DOM_SALES.items():
    for i, net in enumerate(nets):
        vat = d2(Decimal(net) * Decimal("0.13"))
        total = d2(Decimal(net) + vat)
        add_voucher("DR", md(m, 10 if i == 0 else 20), [
            ("112201", None, "S", total, "国内销售-苏州晟维电子 含13%%销项税" , None),
            ("600102", None, "H", d2(net), "国内销售收入-精密部件", None),
            ("222101", None, "H", vat, "销项税额13%%", None),
        ], ref="DOM-%02d%02d" % (m, i + 1), ddate=md(m, 9 if i == 0 else 19))

# ---- 4. 客户借项凭证（DA，4 月运费补收） -----------------------------------
add_voucher("DA", md(4, 22), [
    ("112202", "USD", "S", d2(2800), "运费补收-美元客户 NextGen Robotics", None),
    ("600101", "USD", "H", d2(2800), "补收出口运费冲减销售", None),
], ref="DA-FRT-2604", ddate=md(4, 20))

# ---- 5. 美元回款（DZ） -------------------------------------------------------
USD_COLL = {1: [120000], 2: [145000], 3: [140000], 4: [155000], 5: [150000], 6: [145000]}
for m, amounts in USD_COLL.items():
    for amt in amounts:
        add_voucher("DZ", md(m, 26), [
            ("100102", "USD", "S", d2(amt), "收到美元客户货款-中行美元户入账", None),
            ("112202", "USD", "H", d2(amt), "核销美元应收账款 NextGen Robotics", None),
        ], ref="RECV-US-%02d" % m)

# ---- 6. 欧元回款（DZ） -------------------------------------------------------
for m in range(1, 7):
    add_voucher("DZ", md(m, 26), [
        ("100103", "EUR", "S", d2(40000), "收到欧元客户货款-中行欧元户入账", None),
        ("112203", "EUR", "H", d2(40000), "核销欧元应收账款 Rheinwerk GmbH", None),
    ], ref="RECV-EU-%02d" % m)

# ---- 7. 国内应收回款（DZ） ---------------------------------------------------
DOM_COLL = {1: 930000, 2: 937900, 3: 1469000, 4: 949200, 5: 1525500, 6: 960500}
for m, amt in DOM_COLL.items():
    add_voucher("DZ", md(m, 15), [
        ("100101", None, "S", d2(amt), "收到国内客户货款-工行人民币户", None),
        ("112201", None, "H", d2(amt), "核销国内应收账款 苏州晟维电子", None),
    ], ref="RECV-CN-%02d" % m)

# ---- 8. 应收票据（2 月收票、4 月到期） -------------------------------------
add_voucher("DR", md(2, 20), [
    ("112101", None, "S", d2(200000), "收到银行承兑汇票-苏州晟维电子", None),
    ("112201", None, "H", d2(200000), "应收账款转应收票据", None),
], ref="NOTE-2602")
add_voucher("DZ", md(4, 16), [
    ("100101", None, "S", d2(200000), "承兑汇票到期托收-工行入账", None),
    ("112101", None, "H", d2(200000), "应收票据到期核销", None),
], ref="NOTE-2604")

# ---- 9. 美元进口材料（KR 供应商发票） ---------------------------------------
USD_IMPORTS = {1: 40000, 2: 35000, 3: 45000, 4: 30000, 5: 50000, 6: 20000}
for m, amt in USD_IMPORTS.items():
    add_voucher("KR", md(m, 9), [
        ("140101", "USD", "S", d2(amt), "进口原材料入库-特种合金棒材", None),
        ("203002", "USD", "H", d2(amt), "美元供应商应付账款 Pacific Metals", None),
    ], ref="PO-US-%02d" % m, assign="US-VEND-301", ddate=md(m, 6))

# ---- 10. 国内材料采购（KR，13% 进项税） ------------------------------------
for m in range(1, 7):
    net = 1000000
    vat = d2(Decimal(net) * Decimal("0.13"))
    total = d2(Decimal(net) + vat)
    add_voucher("KR", md(m, 9), [
        ("140101", None, "S", d2(net), "国内采购原材料-铝合金板材", None),
        ("222103", None, "S", vat, "进项税额13%", None),
        ("203001", None, "H", total, "国内供应商应付账款 苏州金属材料", None),
    ], ref="PO-CN-%02d" % m, assign="CN-VEND-501", ddate=md(m, 7))

# ---- 11. 美元供应商付款（KZ） -----------------------------------------------
USD_PAY = {1: 45000, 2: 40000, 3: 40000, 4: 45000, 5: 50000, 6: 40000}
for m, amt in USD_PAY.items():
    add_voucher("KZ", md(m, 20), [
        ("203002", "USD", "S", d2(amt), "支付美元供应商货款-电汇", None),
        ("100102", "USD", "H", d2(amt), "中行美元户付汇", None),
    ], ref="PAY-US-%02d" % m)

# ---- 12. 国内供应商付款（KZ） -----------------------------------------------
DOM_PAY = {1: 1500000, 2: 1130000, 3: 1130000, 4: 1130000, 5: 1130000, 6: 1130000}
for m, amt in DOM_PAY.items():
    add_voucher("KZ", md(m, 20), [
        ("203001", None, "S", d2(amt), "支付国内供应商货款-工行转账", None),
        ("100101", None, "H", d2(amt), "工行人民币户付款", None),
    ], ref="PAY-CN-%02d" % m)

# ---- 13. 结汇（SA）：美元兑人民币 ------------------------------------------
FX_SETTLE = {1: (22, 200000), 4: (18, 200000), 6: (24, 300000)}
for m, (day, usd) in FX_SETTLE.items():
    cny = d2(Decimal(usd) * BOOK_RATES["USD"])
    add_voucher("SA", md(m, day), [
        ("100101", None, "S", cny, "结汇收入-工行人民币户入账", None),
        ("100102", "USD", "H", d2(usd), "结汇卖出美元-中行美元户", None),
    ], ref="FX-SETTLE-%02d" % m)

# ---- 14. 关联方美元往来（SA） ----------------------------------------------
add_voucher("SA", md(1, 15), [
    ("100102", "USD", "S", d2(50000), "收到集团资金池拨入-美元", None),
    ("112302", "USD", "H", d2(50000), "关联方往来-母公司 Senblue Group", None),
], ref="IC-IN-2601")
add_voucher("SA", md(5, 15), [
    ("112302", "USD", "S", d2(60000), "归还集团资金池借款-美元", None),
    ("100102", "USD", "H", d2(60000), "关联方往来归还-中行美元户付汇", None),
], ref="IC-OUT-2605")

# ---- 15. 工资与社保（SA） ---------------------------------------------------
for m in range(1, 7):
    add_voucher("SA", md(m, last_day(m)), [
        ("660201", None, "S", d2(372000), "计提本月职工薪酬及社保公积金", None),
        ("220201", None, "H", d2(330000), "应付职工薪酬-工资", None),
        ("220202", None, "H", d2(42000), "应付职工薪酬-社保公积金", None),
    ], ref="PAYROLL-%02d" % m)
# 1 月支付期初应付（含代扣），2-6 月支付上月
add_voucher("SA", md(1, 5), [
    ("220201", None, "S", d2(380000), "支付上年12月工资", None),
    ("220202", None, "S", d2(118000), "支付上年12月社保公积金", None),
    ("224101", None, "S", d2(61300), "代扣个人社保公积金及个税缴纳", None),
    ("100101", None, "H", d2(380000 + 118000 + 61300), "工行人民币户付款", None),
], ref="PAY-2601")
for m in range(2, 7):
    add_voucher("SA", md(m, 5), [
        ("220201", None, "S", d2(330000), "支付上月工资", None),
        ("220202", None, "S", d2(42000), "支付上月社保公积金", None),
        ("100101", None, "H", d2(372000), "工行人民币户付款", None),
    ], ref="PAY-%02d" % m)

# ---- 16. 折旧（SA） ---------------------------------------------------------
for m in range(1, 7):
    add_voucher("SA", md(m, last_day(m)), [
        ("660202", None, "S", d2(57500), "计提本月折旧", None),
        ("160201", None, "H", d2(57500), "累计折旧", None),
    ], ref="DEPR-%02d" % m)

# ---- 17. 生产与成本结转（SA） ----------------------------------------------
PROD = {1: 1300000, 2: 1250000, 3: 1350000, 4: 1280000, 5: 1380000, 6: 1320000}
COGS = {1: 1420000, 2: 1380000, 3: 1450000, 4: 1410000, 5: 1470000, 6: 1460000}
for m in range(1, 7):
    add_voucher("SA", md(m, 28), [
        ("140501", None, "S", d2(PROD[m]), "本月完工产品入库", None),
        ("140101", None, "H", d2(PROD[m]), "本月领用原材料(人民币)", None),
    ], ref="PROD-%02d" % m)
    add_voucher("SA", md(m, 28), [
        ("640101", None, "S", d2(COGS[m]), "结转本月销售成本", None),
        ("140501", None, "H", d2(COGS[m]), "库存商品出库", None),
    ], ref="COGS-%02d" % m)

# ---- 18. 借款利息（SA） ----------------------------------------------------
add_voucher("SA", md(3, 31), [
    ("660301", None, "S", d2(32625), "支付一季度短期借款利息", None),
    ("100101", None, "H", d2(32625), "工行人民币户付息", None),
], ref="INT-2603")
add_voucher("SA", md(6, 30), [
    ("660301", None, "S", d2(21750), "支付二季度短期借款利息", None),
    ("100101", None, "H", d2(21750), "工行人民币户付息", None),
], ref="INT-2606")
add_voucher("SA", md(3, 31), [
    ("200101", None, "S", d2(1000000), "归还部分短期借款", None),
    ("100101", None, "H", d2(1000000), "工行人民币户还款", None),
], ref="LOAN-REP-2603")

# ---- 19. 美元账户手续费（SA，1/3/6 月） -----------------------------------
USD_FEES = {1: 180, 3: 190, 6: 210}
for m, fee in USD_FEES.items():
    add_voucher("SA", md(m, 25), [
        ("660303", "USD", "S", d2(fee), "中行美元户账户管理费及付汇手续费", None),
        ("100102", "USD", "H", d2(fee), "美元户手续费扣收", None),
    ], ref="FEE-US-%02d" % m)

# ---- 20. 增值税结转与缴纳（SA） --------------------------------------------
add_voucher("SA", md(2, 28), [
    ("222101", None, "S", d2(39000), "结转未交增值税(销项-进项)", None),
    ("222102", None, "H", d2(39000), "未交增值税", None),
], ref="VAT-TRF-2602")
add_voucher("SA", md(3, 15), [
    ("222102", None, "S", d2(39000), "缴纳2月未交增值税", None),
    ("100101", None, "H", d2(39000), "工行人民币户缴税", None),
], ref="VAT-PAY-2603")

# ---- 21. 水电办公费用（KR/SA，经 203003） ---------------------------------
add_voucher("KZ", md(1, 20), [
    ("203003", None, "S", d2(96500), "支付期初费用类应付款", None),
    ("100101", None, "H", d2(96500), "工行人民币户付款", None),
], ref="UTIL-PAY-2601")
for m in (2, 4, 6):
    add_voucher("KR", md(m, 22), [
        ("660203", None, "S", d2(38000), "水电费及物业管理费", None),
        ("203003", None, "H", d2(38000), "费用类应付-苏州工业园区物业", None),
    ], ref="UTIL-%02d" % m, ddate=md(m, 20))
for m, amt in ((3, 38000), (5, 38000)):
    add_voucher("KZ", md(m, 20), [
        ("203003", None, "S", d2(amt), "支付水电物业费用", None),
        ("100101", None, "H", d2(amt), "工行人民币户付款", None),
    ], ref="UTIL-PAY-%02d" % m)

# ---- 22. 运输费与报关费（KR/SA） -------------------------------------------
for m in range(1, 7):
    add_voucher("KR", md(m, 23), [
        ("660101", None, "S", d2(36000), "出口运输费-中日通国际货运", None),
        ("203001", None, "H", d2(36000), "运输费应付", None),
    ], ref="FRT-%02d" % m, ddate=md(m, 21))
for m in (3, 6):
    add_voucher("SA", md(m, 24), [
        ("660102", None, "S", d2(12000), "出口报关及代理费", None),
        ("100101", None, "H", d2(12000), "工行人民币户付款", None),
    ], ref="CUS-%02d" % m)

# ---- 23. 设备采购 ----------------------------------------------------------
add_voucher("KR", md(3, 12), [
    ("160102", None, "S", d2(260000), "购入检测电子设备", None),
    ("100101", None, "H", d2(260000), "工行人民币户付款", None),
], ref="FA-2603", ddate=md(3, 10))
# 欧元设备采购并直接付汇（KR，外币凭证：固定资产行随凭证货币记欧元）
add_voucher("KR", md(2, 20), [
    ("160101", "EUR", "S", d2(200000), "购入五轴数控机床(欧元计价)", None),
    ("100103", "EUR", "H", d2(200000), "中行欧元户付汇", None),
], ref="FA-EUR-2602", ddate=md(2, 18))

# ---- 24. 出口退税申报（SA，6 月） ------------------------------------------
add_voucher("SA", md(6, 25), [
    ("112303", None, "S", d2(96000), "申报出口退税应退税款", None),
    ("222101", None, "H", d2(96000), "出口退税", None),
], ref="REFUND-2606")

# ----------------------------------------------------------------------------
# 聚合：先算 USD 重估前的余额，生成 6 月底 USD 重估凭证（预埋点 2 的"已重估侧"）
# ----------------------------------------------------------------------------
movement = defaultdict(lambda: {"orig_dr": Decimal(0), "orig_cr": Decimal(0),
                                "loc_dr": Decimal(0), "loc_cr": Decimal(0)})


def voucher_line_local(line):
    code, currency, dc, orig, text, local_override = line
    if local_override is not None:
        return local_override
    return calc_local(code, currency, orig)


def accumulate(vouchers):
    for v in vouchers:
        for line in v["lines"]:
            code, currency, dc, orig, text, _ = line
            cur = currency or "CNY"
            local = voucher_line_local(line)
            mv = movement[(code, cur)]
            if dc == "S":
                mv["orig_dr"] += orig
                mv["loc_dr"] += local
            else:
                mv["orig_cr"] += orig
                mv["loc_cr"] += local


accumulate(VOUCHERS)

opening_map = {}
for code, cur, orig, local in OPENING:
    opening_map[(code, cur)] = (orig, local)
    movement[(code, cur)]  # 确保键存在

# 期初轧平项：未分配利润（贷方正数余额，以借正贷负记为负数）
signed_sum = sum(v[1] for v in opening_map.values())
retained = d2(-signed_sum)
assert retained < 0, "期初未分配利润应为贷方余额（借正贷负口径下为负）"
opening_map[("410301", "CNY")] = (retained, retained)
movement[("410301", "CNY")]


def balance(code, cur):
    o_orig, o_loc = opening_map[(code, cur)]
    mv = movement[(code, cur)]
    c_orig = o_orig + mv["orig_dr"] - mv["orig_cr"]
    c_loc = o_loc + mv["loc_dr"] - mv["loc_cr"]
    return c_orig, c_loc


# USD 货币性科目期末重估：本位币余额调至 原币 x 期末汇率(7.18)
# 调整行方向：本位币余额向借方移(delta>0)记 S、向贷方移(delta<0)记 H，
# 与科目资产/负债属性无关；净影响(各科目 delta 之和)为正即未实现汇兑收益。
reval_lines = []
reval_net = Decimal(0)
for code in sorted(MONETARY_ACCOUNTS):
    key = (code, "USD")
    if key not in opening_map and key not in movement:
        continue
    o_orig, o_loc = opening_map[key]
    mv = movement[key]
    c_orig = o_orig + mv["orig_dr"] - mv["orig_cr"]
    c_loc = o_loc + mv["loc_dr"] - mv["loc_cr"]
    target = d2(c_orig * END_RATES["USD"])
    delta = d2(target - c_loc)
    if delta == 0:
        continue
    reval_net += delta
    reval_lines.append((code, "USD", "S" if delta > 0 else "H", Decimal(0),
                        "期末外币重估调整(FAGL_FCV) USD", d2(abs(delta))))
if reval_net != 0:
    reval_lines.append(("660302", None, "H" if reval_net > 0 else "S",
                        d2(abs(reval_net)),
                        "期末外币货币性项目重估损益-USD(收益)" if reval_net > 0
                        else "期末外币货币性项目重估损益-USD(损失)",
                        d2(abs(reval_net))))
add_voucher("SA", date(2026, 6, 30), reval_lines,
            ref="FAGL_FCV-USD-2606", assign="2026-06", user="SLPBATCH")

# 重估凭证入账后重新累计
movement.clear()
accumulate(VOUCHERS)

USD_REVAL_BOOKED = d2(abs(reval_net))

# ----------------------------------------------------------------------------
# 生成 TB 行（科目 x 币种）
# ----------------------------------------------------------------------------
CURRENCY_ORDER = {"CNY": 0, "EUR": 1, "USD": 2}
tb_rows = []
for (code, cur) in sorted(set(opening_map) | set(movement),
                          key=lambda k: (k[0], CURRENCY_ORDER.get(k[1], 9))):
    o_orig, o_loc = opening_map.get((code, cur), (Decimal(0), Decimal(0)))
    mv = movement[(code, cur)]
    c_orig = o_orig + mv["orig_dr"] - mv["orig_cr"]
    c_loc = o_loc + mv["loc_dr"] - mv["loc_cr"]
    tb_rows.append({
        "code": code, "name": ACCOUNTS.get(code, code), "currency": cur,
        "open_orig": o_orig, "open_loc": o_loc,
        "dr_orig": mv["orig_dr"], "cr_orig": mv["orig_cr"],
        "dr_loc": mv["loc_dr"], "cr_loc": mv["loc_cr"],
        "close_orig": c_orig, "close_loc": c_loc,
    })

# ----------------------------------------------------------------------------
# 写出 Excel
# ----------------------------------------------------------------------------
THIN = Side(style="thin", color="BFBFBF")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
HEADER_FILL = PatternFill("solid", fgColor="D9E2F3")
TITLE_FONT = Font(name="微软雅黑", size=12, bold=True)
HEADER_FONT = Font(name="微软雅黑", size=10, bold=True)
BODY_FONT = Font(name="微软雅黑", size=10)


def write_number(ws, row, col, value):
    cell = ws.cell(row=row, column=col)
    if value is None:
        return cell
    cell.value = float(value)
    cell.number_format = "#,##0.00"
    return cell


def style_header(ws, row, ncols):
    for c in range(1, ncols + 1):
        cell = ws.cell(row=row, column=c)
        cell.font = HEADER_FONT
        cell.fill = HEADER_FILL
        cell.border = BORDER
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)


# ---- TB：SAP_科目余额表.xlsx ------------------------------------------------
TB_HEADERS = [
    "Company Code",
    "G/L Account",
    "Account Name",
    "Currency",
    "Period",
    "Opening Balance (Doc. Curr.) 期初原币余额",
    "Debit (Doc. Curr.) 原币借方发生额",
    "Credit (Doc. Curr.) 原币贷方发生额",
    "Balance (Doc. Curr.) 期末原币余额",
    "Opening Balance (Local Curr.) 期初本位币余额",
    "Debit (Local Curr.) 本年累计借方发生额",
    "Credit (Local Curr.) 本年累计贷方发生额",
    "Balance (Local Curr.) 期末本位币余额",
]

wb_tb = Workbook()
ws_tb = wb_tb.active
ws_tb.title = "GL Balances"
ws_tb["A1"] = "G/L Account Balances 01.01.2026 - 30.06.2026"
ws_tb["A1"].font = TITLE_FONT
ws_tb["A2"] = ("Company Code: SLP  |  %s  |  Fiscal Year 2026, "
               "Period 001 - 006  |  Local Currency: CNY" % ENTITY_CN)
ws_tb["A2"].font = Font(name="微软雅黑", size=10, italic=True)

HEADER_ROW_TB = 4
for c, h in enumerate(TB_HEADERS, start=1):
    ws_tb.cell(row=HEADER_ROW_TB, column=c, value=h)
style_header(ws_tb, HEADER_ROW_TB, len(TB_HEADERS))

r = HEADER_ROW_TB + 1
for row in tb_rows:
    ws_tb.cell(row=r, column=1, value=COMPANY_CODE)
    ws_tb.cell(row=r, column=2, value=row["code"])
    ws_tb.cell(row=r, column=3, value=row["name"])
    ws_tb.cell(row=r, column=4, value=row["currency"])
    ws_tb.cell(row=r, column=5, value="001-006")
    write_number(ws_tb, r, 6, row["open_orig"])
    write_number(ws_tb, r, 7, row["dr_orig"])
    write_number(ws_tb, r, 8, row["cr_orig"])
    write_number(ws_tb, r, 9, row["close_orig"])
    write_number(ws_tb, r, 10, row["open_loc"])
    write_number(ws_tb, r, 11, row["dr_loc"])
    write_number(ws_tb, r, 12, row["cr_loc"])
    write_number(ws_tb, r, 13, row["close_loc"])
    for c in range(1, len(TB_HEADERS) + 1):
        cell = ws_tb.cell(row=r, column=c)
        cell.border = BORDER
        cell.font = BODY_FONT
    r += 1

tb_widths = [13, 12, 42, 10, 10, 15, 15, 15, 15, 15, 15, 15, 15]
for i, w in enumerate(tb_widths, start=1):
    ws_tb.column_dimensions[get_column_letter(i)].width = w
ws_tb.freeze_panes = "A5"
TB_PATH = os.path.join(BASE_DIR, "SAP_科目余额表.xlsx")
wb_tb.save(TB_PATH)

# ---- JE：SAP_凭证明细.xlsx --------------------------------------------------
JE_HEADERS = [
    "Company Code",
    "G/L Account",
    "Account Name",
    "Document No.",
    "Document Type",
    "Posting Date",
    "Document Date",
    "Reference",
    "Assignment",
    "Text",
    "Currency",
    "Amount in Doc. Curr. 原币金额",
    "Dr/Cr",
    "Amount in Local Curr. 本位币金额",
    "User Name",
]

wb_je = Workbook()
ws_je = wb_je.active
ws_je.title = "Line Items"
for c, h in enumerate(JE_HEADERS, start=1):
    ws_je.cell(row=1, column=c, value=h)
style_header(ws_je, 1, len(JE_HEADERS))

je_line_count = 0
r = 2
for v in sorted(VOUCHERS, key=lambda x: (x["pdate"], x["no"])):
    for (code, currency, dc, orig, text, local_override) in v["lines"]:
        cur = currency or "CNY"
        local = voucher_line_local((code, currency, dc, orig, text, local_override))
        ws_je.cell(row=r, column=1, value=COMPANY_CODE)
        ws_je.cell(row=r, column=2, value=code)
        ws_je.cell(row=r, column=3, value=ACCOUNTS.get(code, code))
        ws_je.cell(row=r, column=4, value=v["no"])
        ws_je.cell(row=r, column=5, value=v["dtype"])
        c_date = ws_je.cell(row=r, column=6, value=v["pdate"])
        c_date.number_format = "DD.MM.YYYY"
        d_date = ws_je.cell(row=r, column=7, value=v["ddate"])
        d_date.number_format = "DD.MM.YYYY"
        ws_je.cell(row=r, column=8, value=v["ref"])
        ws_je.cell(row=r, column=9, value=v["assign"])
        ws_je.cell(row=r, column=10, value=text)
        # 预埋点 1：本位币(CNY)行币种留空，仅外币行填 USD/EUR
        if currency in (None, "CNY"):
            ws_je.cell(row=r, column=11, value=None)
        else:
            ws_je.cell(row=r, column=11, value=currency)
        write_number(ws_je, r, 12, orig)
        ws_je.cell(row=r, column=13, value=dc)
        write_number(ws_je, r, 14, local)
        ws_je.cell(row=r, column=15, value=v["user"])
        for c in range(1, len(JE_HEADERS) + 1):
            cell = ws_je.cell(row=r, column=c)
            cell.border = BORDER
            cell.font = BODY_FONT
        r += 1
        je_line_count += 1

je_widths = [13, 12, 40, 14, 12, 12, 12, 18, 12, 46, 9, 14, 7, 14, 11]
for i, w in enumerate(je_widths, start=1):
    ws_je.column_dimensions[get_column_letter(i)].width = w
ws_je.freeze_panes = "A2"
JE_PATH = os.path.join(BASE_DIR, "SAP_凭证明细.xlsx")
wb_je.save(JE_PATH)

# ----------------------------------------------------------------------------
# 自检
# ----------------------------------------------------------------------------
checks = []


def check(name, ok, detail=""):
    checks.append((name, ok, detail))
    print("[%s] %s%s" % ("PASS" if ok else "FAIL", name, (" -- " + detail) if detail else ""))


print("=" * 72)
print("SAP 汇率损益测试集 自检报告")
print("=" * 72)

# 1. 每张凭证本位币借贷平衡；单一币种凭证同时校验原币借贷平衡
#    （结汇、重估等跨币种凭证天然存在币种间原币差额，只校验本位币平衡）
voucher_ok = True
multi_currency_docs = 0
for v in VOUCHERS:
    dr_loc = sum(voucher_line_local(l) for l in v["lines"] if l[2] == "S")
    cr_loc = sum(voucher_line_local(l) for l in v["lines"] if l[2] == "H")
    if dr_loc != cr_loc:
        voucher_ok = False
        print("      凭证 %s(%s) 本位币不平衡: Dr %s / Cr %s" % (v["no"], v["dtype"], dr_loc, cr_loc))
    currencies = {(l[1] or "CNY") for l in v["lines"]}
    if len(currencies) > 1:
        multi_currency_docs += 1
        continue
    cur = currencies.pop()
    dr = sum(l[3] for l in v["lines"] if l[2] == "S")
    cr = sum(l[3] for l in v["lines"] if l[2] == "H")
    if dr != cr:
        voucher_ok = False
        print("      凭证 %s 原币(%s)不平衡: Dr %s / Cr %s" % (v["no"], cur, dr, cr))
check("每张凭证本位币借贷平衡；单一币种凭证原币借贷平衡（%d 张凭证，其中跨币种凭证 %d 张仅校验本位币）"
      % (len(VOUCHERS), multi_currency_docs), voucher_ok)

# 2. TB 逐行勾稽：期初 + 借方 - 贷方 = 期末（原币、本位币两口径）
tb_ok = True
for row in tb_rows:
    if row["open_orig"] + row["dr_orig"] - row["cr_orig"] != row["close_orig"]:
        tb_ok = False
    if row["open_loc"] + row["dr_loc"] - row["cr_loc"] != row["close_loc"]:
        tb_ok = False
check("TB 逐行勾稽 期初+借方-贷方=期末（原币/本位币两口径，%d 行）" % len(tb_rows), tb_ok)

# 3. 期初、期末试算平衡（本位币）
sum_open = sum(r["open_loc"] for r in tb_rows)
sum_close = sum(r["close_loc"] for r in tb_rows)
check("TB 期初试算平衡（本位币净额合计=0）", sum_open == 0, "合计 %s" % sum_open)
check("TB 期末试算平衡（本位币净额合计=0）", sum_close == 0, "合计 %s" % sum_close)

# 4. TB 期末 = 期初 + JE 净发生（科目 x 币种）
tbje_ok = True
je_net = defaultdict(lambda: [Decimal(0), Decimal(0)])
for v in VOUCHERS:
    for l in v["lines"]:
        cur = l[1] or "CNY"
        local = voucher_line_local(l)
        side = 0 if l[2] == "S" else 1
        je_net[(l[0], cur)][side] += l[3]
        je_net[("loc", l[0], cur)][side] += local
for row in tb_rows:
    key = (row["code"], row["currency"])
    o_orig, o_loc = opening_map.get(key, (Decimal(0), Decimal(0)))
    n_orig = je_net[key][0] - je_net[key][1]
    n_loc = je_net[("loc",) + key][0] - je_net[("loc",) + key][1]
    if o_orig + n_orig != row["close_orig"] or o_loc + n_loc != row["close_loc"]:
        tbje_ok = False
        print("      不平：%s %s" % key)
check("每个科目x币种 TB期末余额 = 期初 + JE净发生（原币/本位币）", tbje_ok)

# 5. 规模
check("TB 行数在 40-80 范围", 40 <= len(tb_rows) <= 80, "实际 %d 行" % len(tb_rows))
check("JE 行项目数在 150-300 范围", 150 <= je_line_count <= 300,
      "实际 %d 行（%d 张凭证）" % (je_line_count, len(VOUCHERS)))

# 6. 币种列形态（预埋点 1）
tb_currencies = {r["currency"] for r in tb_rows}
tb_cur_filled = all(r["currency"] in ("CNY", "USD", "EUR") for r in tb_rows)
check("TB 币种列每行都填（含 CNY 行），取值集合 %s" % sorted(tb_currencies),
      tb_cur_filled and "CNY" in tb_currencies)
je_currencies = set()
je_blank_cny_lines = 0
je_foreign_lines = 0
je_cny_lines = 0
for v in VOUCHERS:
    for l in v["lines"]:
        if l[1] in (None, "CNY"):
            je_cny_lines += 1
        else:
            je_currencies.add(l[1])
            je_foreign_lines += 1
check("JE 币种列'只标外币'形态：CNY 行留空（%d 行），仅外币行填值（%d 行，%s）"
      % (je_cny_lines, je_foreign_lines, sorted(je_currencies)),
      {"USD", "EUR"} <= je_currencies)

# 7. 三类必需列存在且非全空（列名关键词自检，口径同引擎识别词表）
tb_header_text = " | ".join(TB_HEADERS)
je_header_text = " | ".join(JE_HEADERS)
check("TB 含币种列/原币金额列/本位币金额列",
      all(k in tb_header_text for k in ("Currency", "期初原币余额", "期初本位币余额")))
check("JE 含币种列/原币金额列/本位币金额列",
      all(k in je_header_text for k in ("Currency", "原币金额", "本位币金额")))
tb_amount_nonempty = all(
    r["dr_orig"] or r["cr_orig"] or r["open_orig"] or r["close_orig"] for r in tb_rows)
check("TB 金额列非全空（每行至少一个金额列有值）", tb_amount_nonempty)

# 8. 预埋点 2：USD 已足额重估 / EUR 漏重估
print("-" * 72)
print("重估测算（期末汇率 USD=7.18 / EUR=7.90，按 原币期末x期末汇率-本位币期末）：")
usd_ok = True
print("  USD 货币性科目（应已足额重估，差异=0）：")
for code in sorted(MONETARY_ACCOUNTS):
    key = (code, "USD")
    if key not in opening_map and key not in movement:
        continue
    c_orig, c_loc = balance(code, "USD")
    diff = d2(c_orig * END_RATES["USD"] - c_loc)
    print("    %s %s：原币 %s / 本位币 %s -> 重估差额 %s" %
          (code, ACCOUNTS[code], c_orig, c_loc, diff))
    if diff != 0:
        usd_ok = False
check("预埋点2a：USD 货币性科目 6 月底已重估（660302 账面 USD 重估额 %s）" % USD_REVAL_BOOKED,
      usd_ok)

print("  EUR 货币性科目（漏重估，应出现建议调整额）：")
eur_missing_total = Decimal(0)
for code in sorted(EUR_MISSING_ACCOUNTS):
    c_orig, c_loc = balance(code, "EUR")
    diff = d2(c_orig * END_RATES["EUR"] - c_loc)
    eur_missing_total += diff
    print("    %s %s：原币 %s / 本位币 %s -> 应重估未重估 %s" %
          (code, ACCOUNTS[code], c_orig, c_loc, diff))
check("预埋点2b：EUR 科目(100103/112203)漏重估，合计建议调整 %.2f（汇兑收益未入账）"
      % eur_missing_total, eur_missing_total == d2(Decimal("16800")))

# 9. 类型自检：金额为数值单元格、日期为日期单元格
from openpyxl import load_workbook
wb_check_tb = load_workbook(TB_PATH)
ws_check_tb = wb_check_tb.active
amount_types_ok = all(
    isinstance(ws_check_tb.cell(row=ri, column=c).value, (int, float))
    for ri in range(HEADER_ROW_TB + 1, HEADER_ROW_TB + 1 + len(tb_rows))
    for c in (6, 7, 8, 9, 10, 11, 12, 13))
check("TB 金额单元格全部为数值型", amount_types_ok)

wb_check_je = load_workbook(JE_PATH)
ws_check_je = wb_check_je.active
import datetime as _dt
date_types_ok = all(
    isinstance(ws_check_je.cell(row=ri, column=c).value, (_dt.date, _dt.datetime))
    for ri in range(2, 2 + je_line_count) for c in (6, 7))
amount_types_ok_je = all(
    isinstance(ws_check_je.cell(row=ri, column=c).value, (int, float))
    for ri in range(2, 2 + je_line_count) for c in (12, 14))
check("JE 日期单元格为日期型、金额单元格为数值型", date_types_ok and amount_types_ok_je)

# 汇总
print("=" * 72)
failed = [c for c in checks if not c[1]]
print("自检完成：%d 项，通过 %d 项，失败 %d 项" % (len(checks), len(checks) - len(failed), len(failed)))
print("生成文件：")
print("  %s（%d 行数据）" % (TB_PATH, len(tb_rows)))
print("  %s（%d 行项目 / %d 张凭证）" % (JE_PATH, je_line_count, len(VOUCHERS)))
if failed:
    sys.exit(1)
