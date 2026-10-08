# -*- coding: utf-8 -*-
"""借款台账合成测试集生成器（18 份台账 + 标准答案 + 自检）。

设计目标：模拟真实审计现场拿到的借款台账的各种形态——表头布局之脏（大标题、
两级合并表头、一表多段、多 Sheet）、列名流派之乱（客户经理版 / ERP 导出版 / 金蝶 CSV）、
内容之杂（日期写法混排、利率写法混排、多币种、已结清混排）、业务形态之别
（台账 A/B/C/D 四型 + 到期日与四栏发生额齐备的混合型 + 工整对照组）。

标准答案的计息口径与 Rust 内核逐条对齐：
  * 利息 = Σ(本金×天数) × 年利率 ÷ 365；
  * 算头不算尾：止于年中到期日当天不计息；止于报告期末当天计息（2025 全年 365 天）；
  * A/B 型（合同模式）：期末余额列在账时按「期末余额恒定」计息；注明分期还本且
    部分归还的按期中（2025-06-30）切两段；年内到期部分还款的计至到期日、余额续算
    至年末；无余额信息的存续借款按 合同额−累计已还 计息；
  * C/D 型（变动表模式）：有新增/还款日期列的逐日加权（期初余额起算，事件日前
    不含当天）；无日期的按 (期初+期末)÷2 平均粗算；
  * 浮动利率：显式基准列取 列值+加点÷10000；正文「LPR+xxBP」取内置 LPR 报价
    （报告期初 2025-01-01 之前起息的 1 年期品种为 3.10%）；
  * 多段拼接台账各段单位折算为元（单表不折算，保持原单位输出）。

用法：在本目录执行  python generate.py   ——重新生成全部产物（可重复执行）。

注意：openpyxl 写不进公式的缓存结果（真实 Excel 文件由 Excel 保存过必有缓存），
因此公式只放在不参与取数的勾稽列；金额、日期、利率等取数列一律写实值。
"""
import calendar
import csv
import json
import random
from datetime import date, timedelta
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

SEED = 20260926
PERIOD = (date(2025, 1, 1), date(2025, 12, 31))
PERIOD_START, PERIOD_END = PERIOD
MID = date(2025, 6, 30)  # 报告期中点：分期还本无日期时的默认归还时点
OUT_DIR = Path(__file__).parent

rng = random.Random(SEED)

# ---------------------------------------------------------------- 基础素材 --
BANKS = [
    "中国工商银行股份有限公司北京朝阳支行",
    "中国工商银行股份有限公司深圳蛇口支行",
    "中国农业银行股份有限公司北京分行营业部",
    "中国银行股份有限公司北京市分行",
    "中国银行股份有限公司深圳市分行",
    "中国建设银行股份有限公司北京安华支行",
    "交通银行股份有限公司北京分行",
    "招商银行股份有限公司北京分行",
    "招商银行股份有限公司上海分行",
    "中信银行股份有限公司北京望京支行",
    "中国民生银行股份有限公司北京分行",
    "上海浦东发展银行股份有限公司北京分行",
    "兴业银行股份有限公司北京分行",
    "中国光大银行股份有限公司北京分行",
    "华夏银行股份有限公司北京首体支行",
    "平安银行股份有限公司北京分行",
    "中国邮政储蓄银行股份有限公司北京海淀区支行",
    "北京银行股份有限公司建国支行",
    "北京农村商业银行股份有限公司朝阳支行",
    "江苏银行股份有限公司北京分行",
    "宁波银行股份有限公司北京分行",
    "国家开发银行北京市分行",
    "中国进出口银行北京分行",
]
GUARANTEES = ["保证", "抵押", "质押", "信用", "保证+抵押", "抵押+质押"]
PURPOSES = [
    "流动资金借款", "补充流动资金", "借新还旧", "用于置换存量项目贷款",
    "设备更新专项贷款", "原材料采购", "支付工程进度款", "项目一期建设",
    "并购贷款", "经营周转",
]
REPAY_FULL = "到期一次还本"          # 不含「分期」，走期末余额/合同额口径
REPAY_INSTALLMENT = "分期还本"        # 含「分期」，触发期中切分口径
STATUS_ALIVE = "存续"
STATUS_SETTLED = "已结清"
STATUS_EXTENDED = "展期"

THIN = Side(style="thin", color="9AA5B1")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
HEADER_FILL = PatternFill("solid", fgColor="D9E1F2")
TITLE_FONT = Font(name="微软雅黑", size=14, bold=True)
HEADER_FONT = Font(name="微软雅黑", size=10, bold=True)
BODY_FONT = Font(name="微软雅黑", size=10)
CENTER = Alignment(horizontal="center", vertical="center")
AMOUNT_FMT = "#,##0.00"


def rand_bank():
    return rng.choice(BANKS)


def rand_amount(lo, hi):
    """带零头的真实感金额（元）：以 0.5 万为步长上下浮动。"""
    wan = rng.randrange(lo * 2, hi * 2) / 2.0
    return round(wan * 10000.0, 2)


def add_months(d, m):
    """与 chrono checked_add_months 同语义：月份进位、日按目标月末日截断。"""
    total = (d.year * 12 + d.month - 1) + m
    y, mo = total // 12, total % 12 + 1
    return date(y, mo, min(d.day, calendar.monthrange(y, mo)[1]))


def end_from_term(start, months):
    """B 型期限推到期日：起始日 + N 个月 − 1 天（12 个月→2025-01-15~2026-01-14）。"""
    return add_months(start, months) - timedelta(days=1)


# ------------------------------------------------------------ 标准答案口径 --
def interest_contract(cs, ce, contract_opening, closing, repaid, rate,
                      repayment_method=""):
    """A/B 型合同模式利息（元），与 Rust 内核分支逐条对齐。

    closing 传「账面期末余额列的值」；台账没有期末列的文件必须传
    contract_opening（内核按 期初＋新增－归还 推算期末，无发生额列时即合同额），
    此时到期日不截断计息期——这是内核的现行口径（依据文案「未做勾稽对照」），
    由 README 测试点 1 记录。repaid 只认「累计归还列」，没有该列的文件传 0。
    """
    from_d = max(cs, PERIOD_START)
    settled = ce is not None and ce <= PERIOD_END
    segs = []  # (本金, 起, 止, 止日是否计息)
    if ("分期" in repayment_method) and repaid > 0 and 0 < closing < contract_opening:
        segs.append((contract_opening, from_d, MID, False))
        segs.append((closing, max(from_d, MID + timedelta(days=1)), PERIOD_END, True))
    elif closing > 0:
        if settled and closing < contract_opening:
            segs.append((contract_opening, from_d, ce, False))
            segs.append((closing, ce, PERIOD_END, True))
        else:
            segs.append((closing, from_d, PERIOD_END, True))
    elif settled:
        segs.append((contract_opening, from_d, ce, ce == PERIOD_END))
    else:
        segs.append((max(contract_opening - repaid, 0.0), from_d, PERIOD_END, True))
    total = 0.0
    for p, f, t, incl in segs:
        d = ((t - f).days + 1) if incl else (t - f).days
        if d > 0:
            total += p * rate * d / 365.0
    return round(total, 2)


def interest_full_period(cs, amount, rate):
    """无期末余额列台账的现行口径：期末按合同额推算，自 max(起始日,年初)
    计至年末（含当天），到期日不截断。"""
    from_d = max(cs, PERIOD_START)
    d = (PERIOD_END - from_d).days + 1
    if d <= 0:
        return 0.0
    return round(amount * rate * d / 365.0, 2)


def interest_variable(opening, closing, rate, events=None):
    """C/D 型变动表模式利息（元）。events: [(日期, 变动额)]。"""
    if events:
        principal = opening
        cursor = PERIOD_START
        principal_days = 0.0
        for d, change in sorted(events, key=lambda e: e[0]):
            if d < PERIOD_START:
                principal += change
                continue
            if d > PERIOD_END:
                break
            days = max((d - cursor).days, 0)
            principal_days += principal * days
            principal += change
            cursor = d
        tail = max((PERIOD_END - cursor).days + 1, 0)
        principal_days += principal * tail
        return round(principal_days * rate / 365.0, 2)
    avg = (opening + closing) / 2.0
    days = (PERIOD_END - PERIOD_START).days + 1
    return round(avg * rate * days / 365.0, 2)


# ----------------------------------------------------------------- 写表工具 --
def style_header(ws, row, ncols, start_col=1):
    for c in range(start_col, start_col + ncols):
        cell = ws.cell(row=row, column=c)
        cell.font = HEADER_FONT
        cell.fill = HEADER_FILL
        cell.alignment = CENTER
        cell.border = BORDER


def put_date(ws, r, c, d, fmt="yyyy-mm-dd"):
    cell = ws.cell(row=r, column=c, value=d)
    cell.number_format = fmt
    return cell


def put_amount(ws, r, c, v):
    cell = ws.cell(row=r, column=c, value=v)
    cell.number_format = AMOUNT_FMT
    return cell


def body(ws, r, c, v, align=None):
    cell = ws.cell(row=r, column=c, value=v)
    cell.font = BODY_FONT
    if align:
        cell.alignment = align
    return cell


def title_block(ws, text, sub, ncols):
    """年报式大标题：第 1 行标题跨列合并，第 2 行期间与单位说明。"""
    ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=ncols)
    t = ws.cell(row=1, column=1, value=text)
    t.font = TITLE_FONT
    t.alignment = CENTER
    ws.merge_cells(start_row=2, start_column=1, end_row=2, end_column=ncols)
    s = ws.cell(row=2, column=1, value=sub)
    s.font = BODY_FONT
    s.alignment = CENTER


ANSWERS = []  # 每份台账的标准答案


def answer(file, family, form, header_row, sheet, loans, mapping, notes,
           expect_suggested):
    total = {}
    for ln in loans:
        total[ln["currency"]] = round(total.get(ln["currency"], 0.0) + ln["interest"], 2)
    ANSWERS.append({
        "file": file,
        "family": family,
        "expectForm": form,
        "expectHeaderRow": header_row,
        "sheet": sheet,
        "expectLoanCount": len(loans),
        "loans": loans,
        "totalInterestByCurrency": total,
        "mapping": mapping,
        "expectSuggested": expect_suggested,
        "notes": notes,
    })


def loan_rec(loan_id, interest, currency="CNY"):
    return {"id": loan_id, "currency": currency, "interest": interest}


# ===================================================================== 01 ===
def build_01():
    """集团年报式：大标题 + 表尾合计行与制表人行。A 型，14 笔。"""
    file = "01-华源控股集团有限公司-借款明细表.xlsx"
    headers = ["合同编号", "贷款银行", "借款金额", "起始日", "到期日",
               "年利率（%）", "借款用途", "担保方式", "期末余额", "备注"]
    wb = Workbook()
    ws = wb.active
    ws.title = "借款明细表"
    title_block(ws, "华源控股集团有限公司借款明细表", "2025年度    单位：元", len(headers))
    for c, h in enumerate(headers, 1):
        ws.cell(row=3, column=c, value=h)
    style_header(ws, 3, len(headers))

    loans = []
    # 结构：编号、起、到期、利率%、期末余额(万, None=留空)、用途、担保；金额随机生成
    specs = [
        ("HG-2023-011", 2023, 3, 15, 2026, 3, 14, 4.35, 3000.0, "并购贷款", "保证+抵押"),
        ("HG-2023-018", 2023, 6, 20, 2025, 6, 19, 4.10, 2000.0, "项目一期建设", "抵押"),
        ("HG-2023-025", 2023, 9, 8, 2025, 9, 7, 4.15, None, "流动资金借款", "保证"),   # 年内到期结清
        ("HG-2024-002", 2024, 1, 23, 2027, 1, 22, 3.95, 5000.0, "项目一期建设", "抵押"),
        ("HG-2024-007", 2024, 4, 11, 2025, 4, 10, 3.85, 1200.0, "借新还旧", "保证"),
        ("HG-2024-013", 2024, 8, 5, 2025, 8, 4, 3.90, None, "流动资金借款", "信用"),   # 年内到期结清
        ("HG-2024-019", 2024, 11, 28, 2025, 11, 27, 3.75, 800.0, "补充流动资金", "保证"),
        ("HG-2025-003", 2025, 2, 14, 2026, 2, 13, 3.55, 1500.0, "原材料采购", "抵押"),
        ("HG-2025-006", 2025, 4, 9, 2026, 4, 8, 3.60, 2200.5, "设备更新专项贷款", "抵押+质押"),
        ("HG-2025-009", 2025, 5, 30, 2026, 5, 29, 3.60, 1000.0, "经营周转", "信用"),
        ("HG-2025-012", 2025, 8, 18, 2026, 8, 17, 3.45, 3000.0, "用于置换存量项目贷款", "抵押"),
        ("HG-2025-015", 2025, 10, 27, 2026, 10, 26, 3.45, 900.0, "补充流动资金", "保证"),
        ("HG-2025-017", 2025, 12, 5, 2026, 12, 4, 3.40, 600.0, "经营周转", "信用"),
        ("HG-2022-031", 2022, 5, 17, 2025, 5, 16, 4.25, None, "流动资金借款", "抵押"),   # 年中到期结清
    ]
    r = 4
    for no, (lid, y1, m1, d1, y2, m2, d2, rate_pc, closing_wan, use, g) in enumerate(specs):
        amount = rand_amount(500, 6000)
        cs, ce = date(y1, m1, d1), date(y2, m2, d2)
        closing = None if closing_wan is None else round(min(closing_wan * 10000.0, amount), 2)
        bank = BANKS[no % len(BANKS)]
        body(ws, r, 1, lid)
        body(ws, r, 2, bank)
        put_amount(ws, r, 3, amount)
        put_date(ws, r, 4, cs)
        put_date(ws, r, 5, ce)
        c6 = body(ws, r, 6, rate_pc); c6.number_format = "0.00"
        body(ws, r, 7, use)
        body(ws, r, 8, g)
        if closing is not None:
            put_amount(ws, r, 9, closing)
        body(ws, r, 10, "")
        # 标准答案：期末余额列在账且>0 → 余额恒定；留空 → 年内到期视同结清
        interest = interest_contract(
            cs, ce, contract_opening=amount, closing=closing or 0.0,
            repaid=0.0, rate=rate_pc / 100.0)
        loans.append(loan_rec(lid, interest))
        r += 1
    # 表尾合计行当前会被识别为一笔无利率借款（利息 0，README 测试点 1）
    loans.append(loan_rec("合计", 0.0))
    # 表尾：空行 + 合计行（死数）+ 制表人行
    total_row = r + 1
    body(ws, total_row, 1, "合计")
    put_amount(ws, total_row, 3, 287055000.00)
    put_amount(ws, total_row, 9, 21750000.00)
    for c in range(1, len(headers) + 1):
        ws.cell(row=total_row, column=c).font = Font(name="微软雅黑", size=10, bold=True)
    ws.merge_cells(start_row=total_row + 1, start_column=1,
                   end_row=total_row + 1, end_column=len(headers))
    body(ws, total_row + 1, 1, "制表人：王丽丽    复核人：赵铁军    制表日期：2026年1月18日")
    wb.save(OUT_DIR / file)

    answer(
        file=file, family="表头布局", form="A", header_row=3, sheet="",
        loans=loans,
        mapping={"loanId": "合同编号", "lender": "贷款银行", "principal": "借款金额",
                 "startDate": "起始日", "endDate": "到期日", "rate": "年利率（%）",
                 "closingPrincipal": "期末余额", "remark": "备注"},
        expect_suggested={"principal": "借款金额", "startDate": "起始日",
                          "endDate": "到期日", "rate": "年利率（%）"},
        notes="大标题+单位说明占前两行，表头在第 3 行；表尾合计行与制表人行为布局探针。",
    )


# ===================================================================== 02 ===
def build_02():
    """两级合并表头（本金四栏 + 利率组），C 型平均口径，16 笔。"""
    file = "02-天恒置业有限公司-借款台账.xlsx"
    wb = Workbook()
    ws = wb.active
    ws.title = "借款台账"
    # 第 1 行：组表头（仅跨列组写标签并合并）；第 2 行：子表头（工具按此行识别，
    # 单列组的叶子标签也放在这一行——两级表头被压成单行表头时的常见形态）
    groups = [("借款本金（元）", 3, 4), ("利率信息", 7, 4)]
    for name, c0, span in groups:
        ws.merge_cells(start_row=1, start_column=c0, end_row=1, end_column=c0 + span - 1)
        cell = ws.cell(row=1, column=c0, value=name)
        cell.alignment = CENTER
    subs = ["合同编号", "放款银行", "期初余额", "本期新增", "本期归还", "期末余额",
            "利率类型", "定价基准（%）", "加点（BP）", "执行利率（%）", "备注"]
    for i, s in enumerate(subs, 1):
        ws.cell(row=2, column=i, value=s)
    for rr in (1, 2):
        style_header(ws, rr, len(subs))
        for cc in range(1, len(subs) + 1):
            ws.cell(row=rr, column=cc).border = BORDER

    loans = []
    r = 3
    for i in range(1, 17):
        lid = f"TH-ZY-2023{i:02d}"
        op_wan = rng.randrange(800, 9000)
        add_wan = rng.choice([0, 0, 0, 200, 500, 800, 1200])
        red_wan = min(rng.choice([0, 0, 300, 500, 1000, 1500]), op_wan // 2)
        cp_wan = op_wan + add_wan - red_wan
        floating = i % 4 == 0
        if floating:
            rtype, bench_pc, bps, exec_pc = "浮动", rng.choice([3.10, 3.60]), rng.randrange(30, 130, 5), None
            rate = bench_pc / 100.0 + bps / 10000.0
        else:
            rtype, bench_pc, bps, exec_pc = "固定", None, None, round(rng.uniform(3.60, 4.90), 2)
            rate = exec_pc / 100.0
        op, ad, rd = (round(x * 10000.0, 2) for x in (op_wan, add_wan, red_wan))
        cp = round(cp_wan * 10000.0, 2)
        body(ws, r, 1, lid)
        body(ws, r, 2, rand_bank())
        put_amount(ws, r, 3, op)
        put_amount(ws, r, 4, ad)
        put_amount(ws, r, 5, rd)
        put_amount(ws, r, 6, cp)
        body(ws, r, 7, rtype)
        if bench_pc is not None:
            body(ws, r, 8, bench_pc).number_format = "0.00"
        if bps is not None:
            body(ws, r, 9, bps)
        if exec_pc is not None:
            body(ws, r, 10, exec_pc).number_format = "0.00"
        body(ws, r, 11, rng.choice(PURPOSES) if i % 3 == 0 else "")
        loans.append(loan_rec(lid, interest_variable(op, cp, rate)))
        r += 1
    wb.save(OUT_DIR / file)

    answer(
        file=file, family="表头布局", form="C", header_row=2, sheet="",
        loans=loans,
        mapping={"loanId": "合同编号", "lender": "放款银行",
                 "openingPrincipal": "期初余额", "drawdownAmount": "本期新增",
                 "repaymentAmount": "本期归还", "closingPrincipal": "期末余额",
                 "rate": "执行利率（%）", "rateType": "利率类型",
                 "benchmarkRate": "定价基准（%）", "spreadBps": "加点（BP）"},
        expect_suggested={"openingPrincipal": "期初余额",
                          "closingPrincipal": "期末余额", "rate": "执行利率（%）"},
        notes="两级合并表头：第 2 行子表头才是列名；C 型无日期列，按(期初+期末)/2平均口径。",
    )


# ===================================================================== 03 ===
def build_03():
    """一表四段拼接：长期（万元）/短期（元）/一年内到期（元）/已结清（万元）。30 笔。"""
    file = "03-明州港务股份有限公司-借款台账（多段）.xlsx"
    wb = Workbook()
    ws = wb.active
    ws.title = "借款台账"

    def seg_header(row, label, cols):
        ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=len(cols))
        seg = ws.cell(row=row, column=1, value=label)
        seg.font = Font(name="微软雅黑", size=11, bold=True)
        seg.alignment = Alignment(horizontal="left", vertical="center")
        for c, h in enumerate(cols, 1):
            ws.cell(row=row + 1, column=c, value=h)
        style_header(ws, row + 1, len(cols))

    loans = []
    r = 1
    # 段 1：长期借款（万元）
    seg_header(r, "一、长期借款（单位：万元）",
               ["合同编号", "贷款银行", "借款金额（万元）", "起始日", "到期日", "利率（%）", "备注"])
    r += 2
    for i in range(1, 13):
        lid = f"MZ-Loan-{i:03d}"
        wan = rng.randrange(2000, 20000)
        cs = date(rng.choice([2022, 2023, 2023, 2024]), rng.randrange(1, 13), rng.randrange(1, 28))
        ce = add_months(cs, rng.choice([36, 48, 60, 84]))
        pc = round(rng.uniform(3.55, 4.85), 2)
        amount = round(wan * 10000.0, 2)
        body(ws, r, 1, lid); body(ws, r, 2, rand_bank())
        put_amount(ws, r, 3, float(wan))
        put_date(ws, r, 4, cs); put_date(ws, r, 5, ce)
        body(ws, r, 6, pc).number_format = "0.00"
        body(ws, r, 7, rng.choice(PURPOSES))
        loans.append(loan_rec(lid, interest_full_period(cs, amount, pc / 100.0)))
        r += 1
    r += 2  # 段间空行
    # 段 2：短期借款（元）
    seg_header(r, "二、短期借款（单位：元）",
               ["借据编号", "贷款行", "放款金额", "放款日", "到期日", "执行利率（%）"])
    r += 2
    for i in range(1, 9):
        lid = f"MZ-ST-{i:03d}"
        amount = rand_amount(300, 4000)
        m = rng.choice([6, 12, 12, 12, 18])
        cs = date(2025, rng.randrange(1, 11), rng.randrange(1, 28)) if i % 3 == 0 else \
             date(rng.choice([2024, 2024, 2025]), rng.randrange(1, 13), rng.randrange(1, 28))
        ce = end_from_term(cs, m)
        if ce <= PERIOD_START:
            cs, ce = date(2025, 3, 12), date(2026, 3, 11)
        pc = round(rng.uniform(3.35, 4.20), 2)
        body(ws, r, 1, lid); body(ws, r, 2, rand_bank())
        put_amount(ws, r, 3, amount)
        put_date(ws, r, 4, cs); put_date(ws, r, 5, ce)
        body(ws, r, 6, pc).number_format = "0.00"
        loans.append(loan_rec(lid, interest_full_period(cs, amount, pc / 100.0)))
        r += 1
    r += 2
    # 段 3：一年内到期的长期借款（元）
    seg_header(r, "三、一年内到期的长期借款（单位：元）",
               ["合同编号", "贷款银行", "借款金额", "起始日", "到期日", "年利率（%）"])
    r += 2
    for i in range(1, 7):
        lid = f"MZ-DQ-{i:03d}"
        amount = rand_amount(1000, 8000)
        cs = date(rng.choice([2023, 2024]), rng.randrange(1, 13), rng.randrange(1, 28))
        ce = date(2025, rng.randrange(1, 13), rng.randrange(1, 28))
        pc = round(rng.uniform(3.60, 4.60), 2)
        body(ws, r, 1, lid); body(ws, r, 2, rand_bank())
        put_amount(ws, r, 3, amount)
        put_date(ws, r, 4, cs); put_date(ws, r, 5, ce)
        body(ws, r, 6, pc).number_format = "0.00"
        loans.append(loan_rec(lid, interest_full_period(cs, amount, pc / 100.0)))
        r += 1
    r += 2
    # 段 4：本年已结清借款（万元）——到期日均早于报告期初，利息应为 0
    seg_header(r, "四、本年已结清借款（单位：万元）",
               ["合同编号", "银行", "借款金额（万元）", "起始日", "到期日", "利率（%）"])
    r += 2
    for i in range(1, 5):
        lid = f"MZ-Settled-{i:03d}"
        wan = rng.randrange(500, 6000)
        cs = date(rng.choice([2022, 2023]), rng.randrange(1, 13), rng.randrange(1, 28))
        ce = date(2024, rng.randrange(1, 13), rng.randrange(1, 28))
        pc = round(rng.uniform(3.70, 4.50), 2)
        body(ws, r, 1, lid); body(ws, r, 2, rand_bank())
        put_amount(ws, r, 3, float(wan))
        put_date(ws, r, 4, cs); put_date(ws, r, 5, ce)
        body(ws, r, 6, pc).number_format = "0.00"
        amount = round(wan * 10000.0, 2)
        loans.append(loan_rec(lid, interest_full_period(cs, amount, pc / 100.0)))
        r += 1
    wb.save(OUT_DIR / file)

    answer(
        file=file, family="表头布局", form="A", header_row=2, sheet="",
        loans=loans,
        mapping={"loanId": "合同编号", "lender": "贷款银行",
                 "principal": "借款金额（万元）", "startDate": "起始日",
                 "endDate": "到期日", "rate": "利率（%）"},
        expect_suggested={"principal": "借款金额（万元）", "startDate": "起始日",
                          "endDate": "到期日"},
        notes="四段拼接：段1/4 万元、段2/3 元，多段时金额统一折元；四段均无期末余额列，按现行口径计至年末（到期日不截断，含已结清段，README 测试点 1）。",
    )


# ===================================================================== 04 ===
def build_04():
    """多 Sheet 工作簿：封面说明 + 借款台账 + 已结清备查。A 型，22 笔。"""
    file = "04-南岭矿业集团有限公司-借款情况表.xlsx"
    wb = Workbook()
    cover = wb.active
    cover.title = "封面"
    cover.cell(row=2, column=2, value="南岭矿业集团有限公司").font = TITLE_FONT
    cover.cell(row=3, column=2, value="借款情况表（2025年度）").font = Font(name="微软雅黑", size=12)
    notes = [
        "编制说明：",
        "1. 本表反映公司 2025 年末银行借款情况，含存续及已结清借款；",
        "2. 数据来源于各贷款银行对账单及借款合同，与账面短期借款/长期借款科目核对一致；",
        "3. 金额单位：人民币元；外币借款按期末中间价折算列示。",
    ]
    for i, t in enumerate(notes):
        cover.cell(row=5 + i, column=2, value=t).font = BODY_FONT

    ws = wb.create_sheet("借款台账")
    headers = ["序号", "合同编号", "贷款银行", "借款金额", "起始日", "到期日",
               "年利率（%）", "担保方式", "借款用途"]
    for c, h in enumerate(headers, 1):
        ws.cell(row=1, column=c, value=h)
    style_header(ws, 1, len(headers))
    loans = []
    r = 2
    for i in range(1, 23):
        lid = f"NL-2024-{i:03d}" if i <= 14 else f"NL-2025-{i - 14:03d}"
        amount = rand_amount(500, 9000)
        if i <= 14:
            cs = date(rng.choice([2023, 2024]), rng.randrange(1, 13), rng.randrange(1, 28))
            ce = add_months(cs, rng.choice([12, 24, 36, 60]))
        else:
            cs = date(2025, rng.randrange(1, 11), rng.randrange(1, 28))
            ce = end_from_term(cs, rng.choice([12, 36]))
        pc = round(rng.uniform(3.35, 4.80), 2)
        body(ws, r, 1, i)
        body(ws, r, 2, lid)
        body(ws, r, 3, rand_bank())
        put_amount(ws, r, 4, amount)
        put_date(ws, r, 5, cs)
        put_date(ws, r, 6, ce)
        body(ws, r, 7, pc).number_format = "0.00"
        body(ws, r, 8, rng.choice(GUARANTEES))
        body(ws, r, 9, rng.choice(PURPOSES))
        loans.append(loan_rec(lid, interest_full_period(cs, amount, pc / 100.0)))
        r += 1

    # 第 3 个 Sheet：已结清借款备查（到期均在报告期前，仅作干扰）
    done = wb.create_sheet("已结清备查")
    done_headers = ["合同编号", "贷款银行", "借款金额", "起始日", "到期日", "年利率（%）"]
    for c, h in enumerate(done_headers, 1):
        done.cell(row=1, column=c, value=h)
    style_header(done, 1, len(done_headers))
    for j in range(1, 6):
        cs = date(2023, rng.randrange(1, 13), rng.randrange(1, 28))
        ce = date(2024, rng.randrange(1, 13), rng.randrange(1, 28))
        body(done, j + 1, 1, f"NL-2023-{j:03d}")
        body(done, j + 1, 2, rand_bank())
        put_amount(done, j + 1, 3, rand_amount(300, 2000))
        put_date(done, j + 1, 4, cs)
        put_date(done, j + 1, 5, ce)
        body(done, j + 1, 6, round(rng.uniform(3.8, 4.6), 2)).number_format = "0.00"
    wb.save(OUT_DIR / file)

    answer(
        file=file, family="表头布局", form="A", header_row=1, sheet="借款台账",
        loans=loans,
        mapping={"loanId": "合同编号", "lender": "贷款银行", "principal": "借款金额",
                 "startDate": "起始日", "endDate": "到期日", "rate": "年利率（%）"},
        expect_suggested={"principal": "借款金额", "startDate": "起始日"},
        notes="三个 Sheet：封面说明 + 借款台账 + 已结清备查；考选对 Sheet。",
    )


# ===================================================================== 05 ===
def build_05():
    """银行客户经理风格列名 + 未偿还本金列 + 分期还本/部分还款。A 型，26 笔。"""
    file = "05-恒信工贸有限公司-银行借款台账.xlsx"
    headers = ["合同编号", "贷款银行", "放款金额", "放款日", "到期日",
               "执行年利率", "未偿还本金", "担保方式", "还款方式", "备注"]
    wb = Workbook()
    ws = wb.active
    ws.title = "银行借款台账"
    for c, h in enumerate(headers, 1):
        ws.cell(row=1, column=c, value=h)
    style_header(ws, 1, len(headers))
    loans = []
    r = 2
    for i in range(1, 27):
        lid = f"HX(GT){i:03d}"
        amount = rand_amount(200, 5000)
        kind = i % 4  # 0 普通存续；1 分期还本部分归还；2 年内到期部分还款后结清；3 年内到期全额结清
        if kind == 1:
            repay_method = f"分期还本（{rng.choice(['按季', '按半年'])}）"
        else:
            repay_method = rng.choice(["到期一次还本", "按季付息、到期还本", "按月付息、到期还本"])
        if i <= 8:
            cs = date(rng.choice([2024]), rng.randrange(1, 13), rng.randrange(1, 28))
            ce = add_months(cs, rng.choice([12, 24]))
        elif kind in (2, 3):
            # 年内到期口径的行：放款日控制在上半年，保证到期日晚于放款日
            cs = date(rng.choice([2024, 2025]), rng.randrange(1, 6), rng.randrange(1, 28))
            ce = add_months(cs, 12)
        else:
            cs = date(2025, rng.randrange(1, 10), rng.randrange(1, 28))
            ce = end_from_term(cs, rng.choice([6, 12, 12]))
        if ce > date(2026, 12, 31):
            ce = date(2026, 6, 30)
        pc = round(rng.uniform(3.40, 4.60), 2)
        # 未偿还本金
        if kind == 0:
            outstanding = amount
        elif kind == 1:
            outstanding = round(amount * rng.choice([0.4, 0.5, 0.6, 0.75]), 2)
        elif kind == 2:
            outstanding = round(amount * 0.3, 2)
            ce = min(ce, date(2025, 9, 20))  # 年内到期且部分还款
        else:
            outstanding = 0.0
            ce = min(ce, date(2025, 11, 30))  # 年内到期全额结清
        repaid = round(amount - outstanding, 2) if outstanding < amount else 0.0
        body(ws, r, 1, lid)
        body(ws, r, 2, rand_bank())
        put_amount(ws, r, 3, amount)
        put_date(ws, r, 4, cs)
        put_date(ws, r, 5, ce)
        body(ws, r, 6, pc).number_format = "0.00"
        put_amount(ws, r, 7, outstanding)
        body(ws, r, 8, rng.choice(GUARANTEES))
        body(ws, r, 9, repay_method)
        body(ws, r, 10, rng.choice(PURPOSES))
        loans.append(loan_rec(lid, interest_contract(
            cs, ce, amount, outstanding, 0.0, pc / 100.0)))
        r += 1
    wb.save(OUT_DIR / file)

    answer(
        file=file, family="列名流派", form="A", header_row=1, sheet="",
        loans=loans,
        mapping={"loanId": "合同编号", "lender": "贷款银行", "principal": "放款金额",
                 "startDate": "放款日", "endDate": "到期日", "rate": "执行年利率",
                 "closingPrincipal": "未偿还本金", "repaymentMethod": "还款方式"},
        expect_suggested={"principal": "放款金额", "startDate": "放款日",
                          "rate": "执行年利率", "closingPrincipal": "未偿还本金"},
        notes="客户经理风格列名（放款金额/放款日/执行年利率/未偿还本金）；期末列在账：存续按余额恒定、"
              "年内到期部分还款两段（合同额计至到期日、余额续算至年末）、全额结清计至到期日。"
              "「分期还本」字样因无累计归还列不触发期中切分（README 测试点 2）。",
    )


# ===================================================================== 06 ===
def build_06():
    """ERP（用友味）导出版：系统列 + 文本日期 + 期限月。B 型，32 笔。"""
    file = "06-中晟机械制造股份有限公司-短期借款明细.xlsx"
    headers = ["序号", "科目编码", "科目名称", "凭证号", "摘要", "贷款银行",
               "借款金额", "借款日期", "期限（月）", "年利率（%）", "经办人"]
    wb = Workbook()
    ws = wb.active
    ws.title = "短期借款"
    for c, h in enumerate(headers, 1):
        ws.cell(row=1, column=c, value=h)
    style_header(ws, 1, len(headers))
    staff = ["刘敏", "张浩", "陈晨"]
    loans = []
    r = 2
    for i in range(1, 33):
        amount = rand_amount(200, 3000)
        months = rng.choice([3, 6, 6, 12, 12, 12, 18, 24])
        y = rng.choice([2024, 2024, 2025])
        cs = date(y, rng.randrange(1, 13), rng.randrange(1, 28))
        pc = round(rng.uniform(3.30, 4.50), 2)
        voucher = f"记-{rng.randrange(1, 900):04d}"
        body(ws, r, 1, i)
        body(ws, r, 2, "2001")
        body(ws, r, 3, "短期借款")
        body(ws, r, 4, voucher)
        body(ws, r, 5, f"收到{rng.choice(['工行', '招行', '中行', '建行'])}短期流动资金贷款")
        body(ws, r, 6, rand_bank())
        put_amount(ws, r, 7, amount)
        # ERP 常见文本日期
        put_date(ws, r, 8, cs, fmt="yyyy-mm-dd")
        cell = ws.cell(row=r, column=8)
        cell.value = cs.strftime("%Y-%m-%d")
        if months <= 12:
            body(ws, r, 9, months)
        elif i % 5 == 0:
            body(ws, r, 9, f"{months}个月")
        else:
            body(ws, r, 9, months)
        body(ws, r, 10, pc).number_format = "0.00"
        body(ws, r, 11, rng.choice(staff))
        ce = end_from_term(cs, months)
        loans.append(loan_rec(voucher, interest_full_period(cs, amount, pc / 100.0)))
        r += 1
    wb.save(OUT_DIR / file)

    answer(
        file=file, family="列名流派", form="B", header_row=1, sheet="",
        loans=loans,
        mapping={"loanId": "凭证号", "lender": "贷款银行", "principal": "借款金额",
                 "startDate": "借款日期", "term": "期限（月）", "rate": "年利率（%）",
                 "remark": "摘要"},
        expect_suggested={"principal": "借款金额", "startDate": "借款日期",
                          "term": "期限（月）", "rate": "年利率（%）"},
        notes="ERP 导出风格：科目/凭证/摘要/经办人等系统列；借款标识取凭证号；期限以月数为主、夹『N个月』文本；"
              "借款日期为文本格式。B 型：到期日 = 起始日 + N 月 − 1 天；无期末余额列，计至年末。",
    )


# ===================================================================== 07 ===
def build_07():
    """金蝶风格 CSV 导出（GBK 编码）。B 型，20 笔。"""
    file = "07-裕丰农业发展有限公司-贷款台账.csv"
    rows = [["合同编号", "贷款机构", "借款金额", "起始日", "期限（月）",
             "执行利率（%）", "还款方式", "备注"]]
    loans = []
    for i in range(1, 21):
        lid = f"YF-DK-2025-{i:03d}"
        amount = rand_amount(100, 2000)
        y = rng.choice([2024, 2025])
        cs = date(y, rng.randrange(1, 13), rng.randrange(1, 28))
        months = rng.choice([6, 12, 12, 12, 24, 36])
        term = rng.choice([str(months), f"{months}个月", "一年"] if months == 12 else [str(months)])
        m_eff = 12 if term == "一年" else months
        pc = round(rng.uniform(3.35, 4.40), 2)
        rows.append([lid, rand_bank(), f"{amount:,.2f}", cs.isoformat(), term,
                     f"{pc:.2f}", rng.choice(["到期一次还本", "按季付息、到期还本"]),
                     rng.choice(PURPOSES)])
        ce = end_from_term(cs, m_eff)
        loans.append(loan_rec(lid, interest_full_period(cs, amount, pc / 100.0)))
    with open(OUT_DIR / file, "w", encoding="gbk", newline="") as f:
        csv.writer(f).writerows(rows)

    answer(
        file=file, family="列名流派", form="B", header_row=1, sheet="",
        loans=loans,
        mapping={"loanId": "合同编号", "lender": "贷款机构", "principal": "借款金额",
                 "startDate": "起始日", "term": "期限（月）", "rate": "执行利率（%）"},
        expect_suggested={"principal": "借款金额", "startDate": "起始日",
                          "term": "期限（月）", "rate": "执行利率（%）"},
        notes="金蝶系统导出 CSV（GBK 编码、金额千分位文本）；期限混写『12』『12个月』『一年』。",
    )


# ===================================================================== 08 ===
def build_08():
    """日期写法万花筒：文本/斜杠/中文/序列号/真日期混排。A 型，24 笔。"""
    file = "08-瑞泰电子科技有限公司-借款台账.xlsx"
    headers = ["借款合同号", "贷款银行", "借款金额", "起始日", "到期日", "利率（%）", "备注"]
    wb = Workbook()
    ws = wb.active
    ws.title = "借款台账"
    for c, h in enumerate(headers, 1):
        ws.cell(row=1, column=c, value=h)
    style_header(ws, 1, len(headers))
    loans = []
    r = 2

    def d_cell(d, style_i):
        """五种写法轮换。"""
        if style_i == 0:
            return ws.cell(row=r, column=4 if True else 4, value=d.isoformat())
        if style_i == 1:
            return ws.cell(row=r, column=4, value=f"{d.year}/{d.month}/{d.day}")
        if style_i == 2:
            return ws.cell(row=r, column=4, value=f"{d.year}年{d.month}月{d.day}日")
        if style_i == 3:
            return ws.cell(row=r, column=4, value=(d - date(1899, 12, 30)).days)
        return ws.cell(row=r, column=4, value=d)

    for i in range(1, 25):
        lid = f"RT{2025 if i > 12 else 2024}-{i:03d}"
        amount = rand_amount(150, 2500)
        y = 2025 if i > 12 else rng.choice([2024, 2024, 2023])
        cs = date(y, rng.randrange(1, 13), rng.randrange(1, 28))
        ce = end_from_term(cs, rng.choice([12, 24]))
        pc = round(rng.uniform(3.40, 4.70), 2)
        body(ws, r, 1, lid)
        body(ws, r, 2, rand_bank())
        put_amount(ws, r, 3, amount)
        d_cell(cs, (i - 1) % 5)
        if (i - 1) % 5 == 3:
            ws.cell(row=r, column=5, value=(ce - date(1899, 12, 30)).days)
        else:
            style = (i) % 5
            if style == 0:
                ws.cell(row=r, column=5, value=ce.isoformat())
            elif style == 1:
                ws.cell(row=r, column=5, value=f"{ce.year}/{ce.month}/{ce.day}")
            elif style == 2:
                ws.cell(row=r, column=5, value=f"{ce.year}年{ce.month}月{ce.day}日")
            else:
                put_date(ws, r, 5, ce)
        body(ws, r, 6, pc).number_format = "0.00"
        body(ws, r, 7, rng.choice(PURPOSES))
        loans.append(loan_rec(lid, interest_full_period(cs, amount, pc / 100.0)))
        r += 1
    wb.save(OUT_DIR / file)

    answer(
        file=file, family="内容写法", form="A", header_row=1, sheet="",
        loans=loans,
        mapping={"loanId": "借款合同号", "lender": "贷款银行", "principal": "借款金额",
                 "startDate": "起始日", "endDate": "到期日", "rate": "利率（%）"},
        expect_suggested={"principal": "借款金额", "startDate": "起始日"},
        notes="同一份表里日期五种写法混排：ISO 文本、斜杠（含无前导零）、中文年月日、"
              "Excel 序列号、真日期单元格——五种写法均应正常解析；无期末余额列，计至年末。",
    )


# ===================================================================== 09 ===
def build_09():
    """利率写法万花筒：数值%/文本%/LPR+BP/基准加点分列。A 型，24 笔。"""
    file = "09-九州物流股份有限公司-借款清单.xlsx"
    headers = ["合同编号", "贷款银行", "借款金额", "起始日", "到期日", "利率",
               "利率类型", "定价基准（%）", "加点（BP）", "备注"]
    wb = Workbook()
    ws = wb.active
    ws.title = "借款清单"
    for c, h in enumerate(headers, 1):
        ws.cell(row=1, column=c, value=h)
    style_header(ws, 1, len(headers))
    loans = []
    r = 2
    for i in range(1, 25):
        lid = f"JZ-{i:03d}"
        amount = rand_amount(300, 3500)
        style = (i - 1) % 4
        cs = date(rng.choice([2023, 2024, 2024]), rng.randrange(1, 13), rng.randrange(1, 28))
        ce = end_from_term(cs, 12)  # 全部 1 年期：LPR 品种确定取 1 年期报价
        body(ws, r, 1, lid)
        body(ws, r, 2, rand_bank())
        put_amount(ws, r, 3, amount)
        put_date(ws, r, 4, cs)
        put_date(ws, r, 5, ce)
        if style == 0:      # 数值百分数
            body(ws, r, 6, round(rng.uniform(3.35, 4.60), 2)).number_format = "0.00"
            rtype, bench, bps = "固定", None, None
            rate = ws.cell(row=r, column=6).value / 100.0
        elif style == 1:    # 文本带百分号
            pct = round(rng.uniform(3.40, 4.70), 2)
            body(ws, r, 6, f"{pct}%")
            rtype, bench, bps = "固定", None, None
            rate = pct / 100.0
        elif style == 2:    # LPR+BP 正文
            bp = rng.randrange(30, 140, 5)
            body(ws, r, 6, f"LPR+{bp}BP")
            rtype, bench, bps = "浮动", None, bp
            rate = 0.031 + bp / 10000.0  # 报告期初 1 年期 LPR 3.10%
        else:               # 基准/加点分列，利率列留空
            bench = rng.choice([3.10, 3.10, 3.60])
            bp = rng.randrange(20, 120, 5)
            body(ws, r, 6, None)
            body(ws, r, 8, bench).number_format = "0.00"
            body(ws, r, 9, bp)
            rtype = "浮动"
            rate = bench / 100.0 + bp / 10000.0
        body(ws, r, 7, rtype)
        if style == 2:
            pass
        elif style != 3:
            body(ws, r, 8, None)
            body(ws, r, 9, None)
        body(ws, r, 10, rng.choice(PURPOSES))
        loans.append(loan_rec(lid, interest_full_period(cs, amount, rate)))
        r += 1
    wb.save(OUT_DIR / file)

    answer(
        file=file, family="内容写法", form="A", header_row=1, sheet="",
        loans=loans,
        mapping={"loanId": "合同编号", "lender": "贷款银行", "principal": "借款金额",
                 "startDate": "起始日", "endDate": "到期日", "rate": "利率",
                 "rateType": "利率类型", "benchmarkRate": "定价基准（%）",
                 "spreadBps": "加点（BP）"},
        expect_suggested={"principal": "借款金额", "rate": "利率"},
        notes="利率四种写法：数值%（3.45）、文本%（3.60%）、正文 LPR+90BP（内置报价期初 1 年期 3.10%）、"
              "定价基准与加点分列。浮动行全部为 1 年期品种且起息早于报告期，基准取值确定；无期末余额列，计至年末。",
    )


# ===================================================================== 10 ===
def build_10():
    """多币种：人民币/美元/港币/欧元混排，币种用中文。A 型，18 笔。"""
    file = "10-远洋渔业集团有限公司-外币借款台账.xlsx"
    headers = ["合同编号", "贷款银行", "币种", "借款金额", "起始日", "到期日",
               "利率（%）", "备注"]
    wb = Workbook()
    ws = wb.active
    ws.title = "外币借款台账"
    for c, h in enumerate(headers, 1):
        ws.cell(row=1, column=c, value=h)
    style_header(ws, 1, len(headers))
    ccys = ["人民币"] * 8 + ["美元"] * 6 + ["港币"] * 3 + ["欧元"]
    rate_ranges = {"人民币": (3.35, 4.30), "美元": (5.00, 5.85),
                   "港币": (3.85, 4.55), "欧元": (3.40, 4.10)}
    amount_wan = {"人民币": (500, 8000), "美元": (50, 600), "港币": (200, 1500),
                  "欧元": (100, 400)}
    foreign_banks = {
        "美元": ["汇丰银行（中国）有限公司上海分行", "花旗银行（中国）有限公司北京分行",
                 "中国银行股份有限公司北京市分行"],
        "港币": ["汇丰银行（中国）有限公司深圳分行", "招商银行股份有限公司深圳分行"],
        "欧元": ["德意志银行（中国）有限公司北京分行"],
    }
    loans = []
    r = 2
    for i, ccy in enumerate(ccys, 1):
        lid = f"YY-{i:03d}"
        lo, hi = rate_ranges[ccy]
        pc = round(rng.uniform(lo, hi), 2)
        wlo, whi = amount_wan[ccy]
        amount = rand_amount(wlo, whi)
        cs = date(rng.choice([2024, 2024, 2025]), rng.randrange(1, 13), rng.randrange(1, 28))
        ce = end_from_term(cs, rng.choice([12, 24, 36]))
        bank = rng.choice(foreign_banks.get(ccy, BANKS[:8]))
        body(ws, r, 1, lid)
        body(ws, r, 2, bank)
        body(ws, r, 3, ccy)
        put_amount(ws, r, 4, amount)
        put_date(ws, r, 5, cs)
        put_date(ws, r, 6, ce)
        body(ws, r, 7, pc).number_format = "0.00"
        body(ws, r, 8, rng.choice(PURPOSES))
        loans.append(loan_rec(lid, interest_full_period(cs, amount, pc / 100.0), ccy))
        r += 1
    wb.save(OUT_DIR / file)

    answer(
        file=file, family="内容写法", form="A", header_row=1, sheet="",
        loans=loans,
        mapping={"loanId": "合同编号", "lender": "贷款银行", "currency": "币种",
                 "principal": "借款金额", "startDate": "起始日", "endDate": "到期日",
                 "rate": "利率（%）"},
        expect_suggested={"principal": "借款金额", "currency": "币种"},
        notes="人民币/美元/港币/欧元四币种混排（币种列中文，答案币种随台账原文），金额为原币、"
              "利息按原币逐笔列示、按币种汇总；无期末余额列，计至年末。",
    )


# ===================================================================== 11 ===
def build_11():
    """C 型余额变动表：期初/新增/归还/期末，无发生日期。20 笔，元。"""
    file = "11-沧州化工有限公司-长期借款台账.xlsx"
    headers = ["借款合同编号", "金融机构", "起息日", "期初余额", "本年新增",
               "本年归还", "期末余额", "年利率（%）", "备注"]
    wb = Workbook()
    ws = wb.active
    ws.title = "长期借款"
    for c, h in enumerate(headers, 1):
        ws.cell(row=1, column=c, value=h)
    style_header(ws, 1, len(headers))
    loans = []
    r = 2
    for i in range(1, 21):
        lid = f"CZ-{i:03d}"
        op_wan = rng.randrange(1000, 20000)
        add_wan = rng.choice([0, 0, 0, 500, 1000, 2000, 3000])
        red_wan = min(rng.choice([0, 0, 500, 800, 1200, 2000]), op_wan // 2)
        cp_wan = op_wan + add_wan - red_wan
        pc = round(rng.uniform(3.55, 4.95), 2)
        op, ad, rd = (round(x * 10000.0, 2) for x in (op_wan, add_wan, red_wan))
        cp = round(cp_wan * 10000.0, 2)
        body(ws, r, 1, lid)
        body(ws, r, 2, rand_bank())
        put_date(ws, r, 3, date(rng.choice([2021, 2022, 2023]), rng.randrange(1, 13), rng.randrange(1, 28)))
        put_amount(ws, r, 4, op)
        put_amount(ws, r, 5, ad)
        put_amount(ws, r, 6, rd)
        put_amount(ws, r, 7, cp)
        body(ws, r, 8, pc).number_format = "0.00"
        body(ws, r, 9, rng.choice(PURPOSES) if i % 4 == 0 else "")
        loans.append(loan_rec(lid, interest_variable(op, cp, pc / 100.0)))
        r += 1
    wb.save(OUT_DIR / file)

    answer(
        file=file, family="内容写法", form="C", header_row=1, sheet="",
        loans=loans,
        mapping={"loanId": "借款合同编号", "lender": "金融机构", "startDate": "起息日",
                 "openingPrincipal": "期初余额", "drawdownAmount": "本年新增",
                 "repaymentAmount": "本年归还", "closingPrincipal": "期末余额",
                 "rate": "年利率（%）"},
        expect_suggested={"openingPrincipal": "期初余额",
                          "closingPrincipal": "期末余额", "rate": "年利率（%）"},
        notes="余额变动表形态：无发生日期列，按（期初+期末）/2 平均口径；起息日列仅为形态判定所需。",
    )


# ===================================================================== 12 ===
def build_12():
    """状态混排：存续/已结清/展期，含年内到期结清与展期借款。A 型，32 笔。"""
    file = "12-百川水务股份有限公司-借款台账（全量）.xlsx"
    headers = ["合同编号", "贷款银行", "借款金额", "起始日", "到期日", "执行利率（%）",
               "还款方式", "借款状态", "期末未偿还本金", "备注"]
    wb = Workbook()
    ws = wb.active
    ws.title = "借款台账"
    for c, h in enumerate(headers, 1):
        ws.cell(row=1, column=c, value=h)
    style_header(ws, 1, len(headers))
    loans = []
    r = 2
    yellow = PatternFill("solid", fgColor="FFF2CC")
    for i in range(1, 33):
        lid = f"BC-{i:03d}"
        amount = rand_amount(300, 6000)
        status = STATUS_ALIVE if i % 5 else (STATUS_EXTENDED if i % 2 else STATUS_SETTLED)
        if status == STATUS_SETTLED:
            if i % 4 == 0:   # 报告期前已结清：利息 0
                cs = date(2023, rng.randrange(1, 13), rng.randrange(1, 28))
                ce = date(2024, rng.randrange(1, 13), rng.randrange(1, 28))
                outstanding = 0.0
            else:            # 年内到期结清
                cs = date(rng.choice([2024, 2025]), rng.randrange(1, 6), rng.randrange(1, 28))
                ce = date(2025, rng.randrange(7, 12), rng.randrange(1, 28))
                outstanding = 0.0
        elif status == STATUS_EXTENDED:
            cs = date(2024, rng.randrange(1, 13), rng.randrange(1, 28))
            ce = date(2026, rng.randrange(1, 13), rng.randrange(1, 28))  # 展期后到期
            outstanding = amount
        else:
            cs = date(rng.choice([2024, 2024, 2025]), rng.randrange(1, 13), rng.randrange(1, 28))
            ce = add_months(cs, rng.choice([12, 24, 36]))
            if ce <= PERIOD_END:
                ce = add_months(ce, 12)  # 存续借款到期日推到报告期外
            outstanding = amount
        pc = round(rng.uniform(3.30, 4.75), 2)
        repay_method = rng.choice(["到期一次还本", "按季付息、到期还本"])
        body(ws, r, 1, lid)
        body(ws, r, 2, rand_bank())
        put_amount(ws, r, 3, amount)
        put_date(ws, r, 4, cs)
        put_date(ws, r, 5, ce)
        body(ws, r, 6, pc).number_format = "0.00"
        body(ws, r, 7, repay_method)
        sc = body(ws, r, 8, status)
        put_amount(ws, r, 9, outstanding)
        note = body(ws, r, 10, "原到期日后展期12个月" if status == STATUS_EXTENDED else "")
        if status == STATUS_EXTENDED:
            sc.fill = yellow
            note.fill = yellow
        repaid = round(amount - outstanding, 2)
        loans.append(loan_rec(lid, interest_contract(
            cs, ce, amount, outstanding, 0.0, pc / 100.0)))
        r += 1
    wb.save(OUT_DIR / file)

    answer(
        file=file, family="内容写法", form="A", header_row=1, sheet="",
        loans=loans,
        mapping={"loanId": "合同编号", "lender": "贷款银行", "principal": "借款金额",
                 "startDate": "起始日", "endDate": "到期日", "rate": "执行利率（%）",
                 "repaymentMethod": "还款方式", "loanStatus": "借款状态",
                 "closingPrincipal": "期末未偿还本金"},
        expect_suggested={"principal": "借款金额",
                          "closingPrincipal": "期末未偿还本金"},
        notes="状态列混排存续/已结清/展期：报告期前结清利息为 0；展期借款到期日为展期后日期、"
              "状态单元格有黄色底色（手工维护痕迹）。",
    )


# ===================================================================== 13 ===
def build_13():
    """A 型标准大份：40 笔常规流贷，工整但金额利率带零头。"""
    file = "13-恒达汽车零部件有限公司-流动资金借款台账.xlsx"
    headers = ["合同编号", "贷款银行", "借款金额", "起始日", "到期日", "年利率（%）",
               "借款用途", "备注"]
    wb = Workbook()
    ws = wb.active
    ws.title = "流贷台账"
    for c, h in enumerate(headers, 1):
        ws.cell(row=1, column=c, value=h)
    style_header(ws, 1, len(headers))
    loans = []
    r = 2
    for i in range(1, 41):
        lid = f"HD-{i:04d}"
        amount = rand_amount(200, 8000)
        cs = date(rng.choice([2023, 2024, 2024, 2025]), rng.randrange(1, 13), rng.randrange(1, 28))
        ce = end_from_term(cs, rng.choice([12, 12, 12, 24, 36]))
        if ce <= PERIOD_END and rng.random() < 0.7:
            ce = add_months(ce, 12)
        pc = round(rng.uniform(3.25, 4.60), 2)
        body(ws, r, 1, lid)
        body(ws, r, 2, rand_bank())
        put_amount(ws, r, 3, amount)
        put_date(ws, r, 4, cs)
        put_date(ws, r, 5, ce)
        body(ws, r, 6, pc).number_format = "0.00"
        body(ws, r, 7, rng.choice(PURPOSES))
        body(ws, r, 8, "")
        loans.append(loan_rec(lid, interest_full_period(cs, amount, pc / 100.0)))
        r += 1
    wb.save(OUT_DIR / file)

    answer(
        file=file, family="业务形态", form="A", header_row=1, sheet="",
        loans=loans,
        mapping={"loanId": "合同编号", "lender": "贷款银行", "principal": "借款金额",
                 "startDate": "起始日", "endDate": "到期日", "rate": "年利率（%）"},
        expect_suggested={"principal": "借款金额", "startDate": "起始日",
                          "endDate": "到期日"},
        notes="A 型大样本（40 笔）：验证批量与金额零头的稳定性；无期末余额列，计至年末。",
    )


# ===================================================================== 14 ===
def build_14():
    """B 型：期限写法多样（数字/中文数字/年/含展期说明）。22 笔。"""
    file = "14-中兴电气股份有限公司-借款合同台账.xlsx"
    headers = ["合同编号", "贷款银行", "借款金额", "起始日", "借款期限", "利率（%）", "备注"]
    wb = Workbook()
    ws = wb.active
    ws.title = "合同台账"
    for c, h in enumerate(headers, 1):
        ws.cell(row=1, column=c, value=h)
    style_header(ws, 1, len(headers))
    term_styles = [lambda m: m, lambda m: f"{m}个月", lambda m: "一年" if m == 12 else f"{m}个月",
                   lambda m: "3年" if m == 36 else (f"{m//12}年" if m % 12 == 0 else f"{m}个月"),
                   lambda m: "17个月（含展期）" if m == 17 else f"{m}个月"]
    loans = []
    r = 2
    for i in range(1, 23):
        lid = f"ZX-HT-{i:03d}"
        amount = rand_amount(300, 5000)
        months = 17 if i % 11 == 0 else rng.choice([3, 6, 12, 12, 12, 24, 36])
        cs = date(rng.choice([2024, 2024, 2025]), rng.randrange(1, 13), rng.randrange(1, 28))
        term_text = term_styles[i % len(term_styles)](months)
        pc = round(rng.uniform(3.30, 4.80), 2)
        body(ws, r, 1, lid)
        body(ws, r, 2, rand_bank())
        put_amount(ws, r, 3, amount)
        put_date(ws, r, 4, cs)
        body(ws, r, 5, term_text)
        body(ws, r, 6, pc).number_format = "0.00"
        body(ws, r, 7, rng.choice(PURPOSES))
        ce = end_from_term(cs, months)
        loans.append(loan_rec(lid, interest_full_period(cs, amount, pc / 100.0)))
        r += 1
    wb.save(OUT_DIR / file)

    answer(
        file=file, family="业务形态", form="B", header_row=1, sheet="",
        loans=loans,
        mapping={"loanId": "合同编号", "lender": "贷款银行", "principal": "借款金额",
                 "startDate": "起始日", "term": "借款期限", "rate": "利率（%）"},
        expect_suggested={"principal": "借款金额", "term": "借款期限"},
        notes="B 型：期限列混写『12』『12个月』『一年』『3年』『17个月（含展期）』，"
              "到期日 = 起始日 + N 月 − 1 天；无期末余额列，计至年末。",
    )


# ===================================================================== 15 ===
def build_15():
    """C 型带发生日期：逐日加权。25 笔（部分行无日期走平均口径）。"""
    file = "15-金穗粮油集团有限公司-借款余额变动表.xlsx"
    headers = ["合同编号", "金融机构", "起息日", "期初余额", "本年新增", "新增借款日期",
               "本年归还", "还款日期", "期末余额", "年利率（%）", "备注"]
    wb = Workbook()
    ws = wb.active
    ws.title = "余额变动表"
    for c, h in enumerate(headers, 1):
        ws.cell(row=1, column=c, value=h)
    style_header(ws, 1, len(headers))
    loans = []
    r = 2
    for i in range(1, 26):
        lid = f"JS-{i:03d}"
        op_wan = rng.randrange(500, 9000)
        add_wan = rng.choice([0, 0, 300, 600, 1000, 1500, 2000])
        red_wan = rng.choice([0, 0, 200, 500, 900, 1300])
        red_wan = min(red_wan, int(op_wan * 0.3))  # 归还不超过期初的三成，余额不穿底
        cp_wan = op_wan + add_wan - red_wan
        pc = round(rng.uniform(3.40, 4.90), 2)
        op, ad, rd = (round(x * 10000.0, 2) for x in (op_wan, add_wan, red_wan))
        cp = round(cp_wan * 10000.0, 2)
        body(ws, r, 1, lid)
        body(ws, r, 2, rand_bank())
        put_date(ws, r, 3, date(rng.choice([2021, 2022, 2023, 2024]), rng.randrange(1, 13), rng.randrange(1, 28)))
        put_amount(ws, r, 4, op)
        put_amount(ws, r, 5, ad)
        put_amount(ws, r, 7, rd)
        put_amount(ws, r, 9, cp)
        body(ws, r, 10, pc).number_format = "0.00"
        body(ws, r, 11, rng.choice(PURPOSES) if i % 5 == 0 else "")
        with_dates = i % 3 != 0  # 每三行一行无日期（平均口径）
        events = []
        if with_dates:
            if ad > 0:
                dd = date(2025, rng.randrange(2, 11), rng.randrange(1, 28))
                put_date(ws, r, 6, dd)
                events.append((dd, ad))
            else:
                body(ws, r, 6, "")
            if rd > 0:
                dd2 = date(2025, rng.randrange(2, 11), rng.randrange(1, 28))
                put_date(ws, r, 8, dd2)
                events.append((dd2, -rd))
            else:
                body(ws, r, 8, "")
            loans.append(loan_rec(lid, interest_variable(op, cp, pc / 100.0, events)))
        else:
            body(ws, r, 6, "")
            body(ws, r, 8, "")
            loans.append(loan_rec(lid, interest_variable(op, cp, pc / 100.0)))
        r += 1
    wb.save(OUT_DIR / file)

    answer(
        file=file, family="业务形态", form="C", header_row=1, sheet="",
        loans=loans,
        mapping={"loanId": "合同编号", "lender": "金融机构", "startDate": "起息日",
                 "openingPrincipal": "期初余额", "drawdownAmount": "本年新增",
                 "drawdownDate": "新增借款日期", "repaymentAmount": "本年归还",
                 "repaymentDate": "还款日期", "closingPrincipal": "期末余额",
                 "rate": "年利率（%）"},
        expect_suggested={"openingPrincipal": "期初余额",
                          "closingPrincipal": "期末余额"},
        notes="C 型带发生日期：有日期行按逐日加权（期初起算、事件日不含当天），"
              "每三行夹一行无日期行按平均口径。",
    )


# ===================================================================== 16 ===
def build_16():
    """D 型期末倒推：期末余额 + 发生额，期初列缺位。20 笔。"""
    file = "16-汉唐文旅发展有限公司-借款台账.xlsx"
    headers = ["合同编号", "贷款银行", "起息日", "本年新增", "新增借款日期",
               "累计归还", "还款日期", "期末余额", "年利率（%）", "备注"]
    wb = Workbook()
    ws = wb.active
    ws.title = "借款台账"
    for c, h in enumerate(headers, 1):
        ws.cell(row=1, column=c, value=h)
    style_header(ws, 1, len(headers))
    loans = []
    r = 2
    for i in range(1, 21):
        lid = f"HT-{i:03d}"
        pc = round(rng.uniform(3.50, 5.10), 2)
        body(ws, r, 1, lid)
        body(ws, r, 2, rand_bank())
        if i <= 16:
            # 年内新放款：新增=全额，期末=新增-年内归还
            amount = rand_amount(200, 4000)
            cs = date(2025, rng.randrange(1, 11), rng.randrange(1, 28))
            red_wan = rng.choice([0, 0, 0, 50, 100, 200])
            rd = round(red_wan * 10000.0, 2)
            cp = round(amount - rd, 2)
            body(ws, r, 3, cs.isoformat())
            put_amount(ws, r, 4, amount)
            put_date(ws, r, 5, cs)
            put_amount(ws, r, 6, rd)
            events = [(cs, amount)]
            if rd > 0:
                dd = date(2025, rng.randrange(11, 13), rng.randrange(1, 28))
                put_date(ws, r, 7, dd)
                events.append((dd, -rd))
            else:
                body(ws, r, 7, "")
            put_amount(ws, r, 8, cp)
            # D 型无期初列：年内新放款走事件逐日加权（期初 0 起算）与业务事实一致
            loans.append(loan_rec(lid, interest_variable(0.0, cp, pc / 100.0, events)))
        else:
            # 期初存续借款、台账未列期初：当前口径按（0+期末）/2 平均（已知口径疑点）
            cs = date(rng.choice([2023, 2024]), rng.randrange(1, 13), rng.randrange(1, 28))
            cp = rand_amount(500, 3000)
            body(ws, r, 3, cs.isoformat())
            body(ws, r, 4, 0).number_format = AMOUNT_FMT
            body(ws, r, 5, "")
            body(ws, r, 6, 0).number_format = AMOUNT_FMT
            body(ws, r, 7, "")
            put_amount(ws, r, 8, cp)
            loans.append(loan_rec(lid, interest_variable(0.0, cp, pc / 100.0)))
        body(ws, r, 9, pc).number_format = "0.00"
        body(ws, r, 10, rng.choice(PURPOSES) if i % 4 == 0 else "")
        r += 1
    wb.save(OUT_DIR / file)

    answer(
        file=file, family="业务形态", form="D", header_row=1, sheet="",
        loans=loans,
        mapping={"loanId": "合同编号", "lender": "贷款银行", "startDate": "起息日",
                 "drawdownAmount": "本年新增", "drawdownDate": "新增借款日期",
                 "repaymentAmount": "累计归还", "repaymentDate": "还款日期",
                 "closingPrincipal": "期末余额", "rate": "年利率（%）"},
        expect_suggested={"closingPrincipal": "期末余额", "rate": "年利率（%）"},
        notes="D 型期末倒推：年内新放款行以「新增借款日期」事件还原逐日加权；"
              "期初存续借款行台账未列期初（当前口径按（0+期末）/2 平均，README 测试点 4 记录该疑点）。",
    )


# ===================================================================== 17 ===
def build_17():
    """混合型：到期日与四栏发生额齐备（勾稽校验态）。16 笔。"""
    file = "17-前湾开发投资有限公司-借款台账.xlsx"
    headers = ["合同编号", "贷款银行", "借款金额", "起始日", "到期日", "执行年利率（%）",
               "期初余额", "本年新增", "本年归还", "期末余额", "勾稽校验"]
    wb = Workbook()
    ws = wb.active
    ws.title = "借款台账"
    for c, h in enumerate(headers, 1):
        ws.cell(row=1, column=c, value=h)
    style_header(ws, 1, len(headers))
    loans = []
    r = 2
    for i in range(1, 17):
        lid = f"QW-{i:03d}"
        amount = rand_amount(1000, 12000)
        cs = date(rng.choice([2023, 2024]), rng.randrange(1, 13), rng.randrange(1, 28))
        ce = add_months(cs, rng.choice([36, 60, 84]))
        pc = round(rng.uniform(3.50, 4.90), 2)
        op = amount if rng.random() < 0.8 else round(amount * 0.9, 2)
        ad = rng.choice([0, 0, 0, round(amount * 0.2, 2)])
        rd = rng.choice([0, 0, round(amount * 0.15, 2)])
        cp = round(op + ad - rd, 2)
        body(ws, r, 1, lid)
        body(ws, r, 2, rand_bank())
        put_amount(ws, r, 3, amount)
        put_date(ws, r, 4, cs)
        put_date(ws, r, 5, ce)
        body(ws, r, 6, pc).number_format = "0.00"
        put_amount(ws, r, 7, op)
        put_amount(ws, r, 8, ad)
        put_amount(ws, r, 9, rd)
        put_amount(ws, r, 10, cp)
        # 勾稽列放活公式（openpyxl 无缓存值，不参与取数）
        ws.cell(row=r, column=11,
                value=f"=IF(G{r}+H{r}-I{r}=J{r},\"平\",\"不平\")")
        # 合同模式：期末余额列在账 → 余额恒定口径（contract_opening 取期初列）
        loans.append(loan_rec(lid, interest_contract(
            cs, ce, op if op > 0 else amount, cp, rd, pc / 100.0)))
        r += 1
    wb.save(OUT_DIR / file)

    answer(
        file=file, family="业务形态", form="A", header_row=1, sheet="",
        loans=loans,
        mapping={"loanId": "合同编号", "lender": "贷款银行", "principal": "借款金额",
                 "startDate": "起始日", "endDate": "到期日", "rate": "执行年利率（%）",
                 "openingPrincipal": "期初余额", "drawdownAmount": "本年新增",
                 "repaymentAmount": "本年归还", "closingPrincipal": "期末余额"},
        expect_suggested={"principal": "借款金额", "endDate": "到期日",
                          "closingPrincipal": "期末余额"},
        notes="混合型（实物 04 前湾式）：A 型 + 四栏发生额齐备，四栏转为勾稽校验；"
              "勾稽列放活公式但不参与取数。",
    )


# ===================================================================== 18 ===
def build_18():
    """工整对照组：列名与工具角色名一致、写法统一。A 型，30 笔。"""
    file = "18-文华教育科技有限公司-借款台账（对照版）.xlsx"
    headers = ["借款标识", "贷款方", "借款本金", "起始日", "到期日", "利率",
               "利率类型", "备注"]
    wb = Workbook()
    ws = wb.active
    ws.title = "借款台账"
    for c, h in enumerate(headers, 1):
        ws.cell(row=1, column=c, value=h)
    style_header(ws, 1, len(headers))
    loans = []
    r = 2
    for i in range(1, 31):
        lid = f"JK-2025-{i:03d}"
        amount = rand_amount(200, 5000)
        cs = date(rng.choice([2024, 2025]), rng.randrange(1, 13), rng.randrange(1, 28))
        ce = end_from_term(cs, rng.choice([12, 24]))
        if ce <= PERIOD_END:
            ce = add_months(ce, 12)
        pc = round(rng.uniform(3.30, 4.50), 2)
        body(ws, r, 1, lid)
        body(ws, r, 2, rand_bank())
        put_amount(ws, r, 3, amount)
        put_date(ws, r, 4, cs)
        put_date(ws, r, 5, ce)
        body(ws, r, 6, pc).number_format = "0.00"
        body(ws, r, 7, "固定")
        body(ws, r, 8, rng.choice(PURPOSES))
        loans.append(loan_rec(lid, interest_full_period(cs, amount, pc / 100.0)))
        r += 1
    wb.save(OUT_DIR / file)

    answer(
        file=file, family="业务形态", form="A", header_row=1, sheet="",
        loans=loans,
        mapping={"loanId": "借款标识", "lender": "贷款方", "principal": "借款本金",
                 "startDate": "起始日", "endDate": "到期日", "rate": "利率",
                 "rateType": "利率类型"},
        expect_suggested={"principal": "借款本金", "startDate": "起始日"},
        notes="对照组：完全工整的表（旧演示样例风格），作为其余 17 份『脏』样本的基线。",
    )


# ------------------------------------------------------------------- 自检 --
def self_check():
    problems = []
    for a in ANSWERS:
        n = len(a["loans"])
        if n != a["expectLoanCount"]:
            problems.append(f"{a['file']}: 笔数不一致")
        for ln in a["loans"]:
            if ln["interest"] < -0.005:
                problems.append(f"{a['file']}/{ln['id']}: 利息为负 {ln['interest']}")
        total = round(sum(l["interest"] for l in a["loans"] if l["currency"] == "CNY"), 2)
        if a["totalInterestByCurrency"].get("CNY", 0.0) != total:
            problems.append(f"{a['file']}: 合计不平")
    return problems


def main():
    for build in (build_01, build_02, build_03, build_04, build_05, build_06,
                  build_07, build_08, build_09, build_10, build_11, build_12,
                  build_13, build_14, build_15, build_16, build_17, build_18):
        build()
        print(f"[GEN] {build.__name__} 完成")

    payload = {
        "reportPeriod": {"start": PERIOD_START.isoformat(), "end": PERIOD_END.isoformat()},
        "dayCount": "算头不算尾；止于报告期末当天计息；全年按 365 天",
        "generatedBy": "generate.py（随机种子 %d，重跑可复现）" % SEED,
        "files": ANSWERS,
    }
    (OUT_DIR / "标准答案.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    problems = self_check()
    for p in problems:
        print("[CHECK-FAIL]", p)
    total_loans = sum(a["expectLoanCount"] for a in ANSWERS)
    print(f"共 {len(ANSWERS)} 份台账、{total_loans} 笔借款；自检{'通过' if not problems else '未通过'}")
    for a in ANSWERS:
        print(f"  {a['file']} | {a['family']} | {a['expectForm']}型 | "
              f"{a['expectLoanCount']}笔 | 合计(元) {a['totalInterestByCurrency']}")


if __name__ == "__main__":
    main()
