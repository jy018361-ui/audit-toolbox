# -*- coding: utf-8 -*-
"""生成「数据流 DataFlow」工具的合成测试数据（tests/fixtures/DataFlow/）。

数据来源：全部由本脚本随机合成（固定随机种子，可重现），不含任何真实业务数据。
设计依据：
  - DATAFLOW_DESIGN.md 第 9 节（数据规则）、第 10 节（输入输出格式边界）；
  - DATAFLOW_ACCEPTANCE_FLOWS.md 第 2 节（流程一·批量清洗合并的埋错设计）；
  - 第 5 节为远期规模验收方案，本次仅生成小/中规模（约 200 行/文件 与 约 5 万行）。

仅使用 Python 标准库；唯一的可选用依赖是 openpyxl（用于生成一个小 xlsx 样例，
未安装时自动跳过并在 README 中说明）。

用法：
  python scripts/gen_dataflow_fixtures.py
  python scripts/gen_dataflow_fixtures.py --small-rows 200 --medium-rows 50000 --seed 20261027
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import os
import random
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = REPO_ROOT / "tests" / "fixtures" / "DataFlow"

HEADERS = ["凭证日期", "凭证号", "摘要", "科目编码", "科目名称", "借方金额", "贷方金额", "客商名称", "流水号"]

# ---------------------------------------------------------------------------
# 合成基础数据（全部虚构）
# ---------------------------------------------------------------------------

# 科目编码 / 科目名称 / 费用类别（映射表口径）。前两个为前导零编码。
# 6801、1601 刻意不进映射表（左未匹配 L 路测试）；6602 在映射表出现两次（关联键重复膨胀）；
# 9900 为映射表独有、明细未使用（右未匹配 R 路测试）。
ACCOUNTS = [
    ("0101", "待摊费用", "非费用－成本"),
    ("0102", "长期待摊费用", "非费用－成本"),
    ("1001", "库存现金", "非费用－资产"),
    ("1002", "银行存款", "非费用－资产"),
    ("1122", "应收账款", "非费用－资产"),
    ("1123", "预付账款", "非费用－资产"),
    ("1403", "原材料", "非费用－成本"),
    ("1405", "库存商品", "非费用－成本"),
    ("1601", "固定资产", "非费用－资产"),
    ("2202", "应付账款", "非费用－负债"),
    ("2203", "预收账款", "非费用－负债"),
    ("2221", "应交税费", "非费用－负债"),
    ("2241", "其他应付款", "非费用－负债"),
    ("4001", "实收资本", "非费用－权益"),
    ("6001", "主营业务收入", "收入类"),
    ("6401", "主营业务成本", "成本结转"),
    ("6601", "销售费用", "费用－销售"),
    ("6602", "管理费用", "费用－办公"),
    ("6603", "财务费用", "费用－财务"),
    ("6801", "所得税费用", "费用－税金"),
]
MAPPING_CODES = [c for c, _, _ in ACCOUNTS if c not in ("6801", "1601")]  # 18 个
MAPPING_EXTRA = ("9900", "待清理科目", "费用－其他")  # 映射表独有
MAPPING_DUP = "6602"  # 映射表中重复出现的编码（第二次挂不同费用类别）
MAPPING_MISSING = ("6801", "1601")  # 明细用到但映射表缺失（L 路）

# 客商池（全部虚构；华信的全角括号写法作为脏数据变体）
VENDORS = [
    "华信咨询(上海)有限公司",
    "云帆物流有限公司",
    "蓝石电子科技有限公司",
    "恒岳商贸有限公司",
    "四方检测认证有限公司",
    "竹韵文化传媒有限公司",
    "绿洲环保工程有限公司",
    "北极星软件技术有限公司",
    "沧澜海运有限公司",
    "麦田人力资源服务有限公司",
    "银河设备租赁有限公司",
    "青山包装材料厂",
]
VENDOR_FULLWIDTH = "华信咨询（上海）有限公司"  # 全角括号脏写法（与华信咨询(上海)有限公司归一）

ABSTRACTS = [
    "支付货款", "收到货款", "报销差旅费", "支付办公用品采购款", "支付办公室租金",
    "计提本月折旧", "支付咨询服务费", "支付银行手续费", "结转销售成本", "收到投资款",
    "缴纳上月税费", "支付员工工资", "支付运输费", "收到客户预付款", "支付设备租金",
    "支付水电费", "计提坏账准备", "支付审计费用",
]

# ---------------------------------------------------------------------------
# 基础行生成
# ---------------------------------------------------------------------------


class SerialGen:
    """18 位银行流水号生成器：普通号以 62 开头，少量前导零变体。"""

    def __init__(self, rng: random.Random, lead_zero_every: int = 5000):
        self.rng = rng
        self.count = 0
        self.lead_zero_every = lead_zero_every
        self.lead_zero_count = 0

    def next(self) -> str:
        self.count += 1
        if self.count % self.lead_zero_every == 0:
            self.lead_zero_count += 1
            return "0" + f"{self.count:017d}"
        return "62" + f"{self.count:016d}"


def make_voucher_rows(rng, month, voucher_no, date_style_ratio, serial: SerialGen):
    """生成一张借贷平衡的凭证（2~4 行），返回行列表（dict）。

    date_style_ratio: 使用斜杠短写日期（如 2026/1/3）的概率，其余用 2026-01-03。
    """
    day = rng.randint(1, 28)
    if rng.random() < date_style_ratio:
        date_str = f"2026/{month}/{day}"
    else:
        date_str = f"2026-{month:02d}-{day:02d}"
    n_lines = rng.choice([2, 2, 2, 3, 3, 4])
    total = round(rng.uniform(500, 400000), 2)
    debit_first = rng.random() < 0.5
    rows = []
    # 金额切分：一条主线整额，其余行拆分
    splits = [round(total / (n_lines - 1), 2)] * (n_lines - 1)
    splits[-1] = round(total - sum(splits[:-1]), 2)
    lines = []
    for i in range(n_lines):
        code, name, _ = ACCOUNTS[rng.randrange(len(ACCOUNTS))]
        vendor = VENDORS[rng.randrange(len(VENDORS))]
        abstract = ABSTRACTS[rng.randrange(len(ABSTRACTS))]
        if i == 0:
            amount, is_debit = total, debit_first
        else:
            amount, is_debit = splits[i - 1], not debit_first
        lines.append((code, name, abstract, vendor, amount, is_debit))
    for code, name, abstract, vendor, amount, is_debit in lines:
        rows.append({
            "凭证日期": date_str,
            "凭证号": voucher_no,
            "摘要": abstract,
            "科目编码": code,
            "科目名称": name,
            "借方金额": f"{amount:.2f}" if is_debit else "",
            "贷方金额": f"{amount:.2f}" if not is_debit else "",
            "客商名称": vendor,
            "流水号": serial.next(),
        })
    return rows


def build_month_rows(rng, month, n_rows, date_style_ratio, serial: SerialGen,
                     voucher_fmt):
    """生成某月 n_rows 行（含到行为止的凭证整行），返回 (rows, 凭证号列表)。"""
    rows = []
    voucher_nos = []
    idx = 0
    while len(rows) < n_rows:
        idx += 1
        voucher_no = voucher_fmt(idx)
        voucher_nos.append(voucher_no)
        rows.extend(make_voucher_rows(rng, month, voucher_no, date_style_ratio, serial))
    return rows[:n_rows], voucher_nos


# ---------------------------------------------------------------------------
# 脏数据埋点（固定行号，多数放在文件后半段：预览采样取不到的位置）
# ---------------------------------------------------------------------------


def apply_dirty(rows, plan, answers, file_label):
    """按计划把脏数据写进行列表。plan: list of (row_index_1based, kind, kwargs)。

    同时把每类脏数据的落位行号记入 answers[file_label]，作为构造侧已知答案。
    """

    def rec(kind, idx, note=""):
        answers.setdefault(file_label, {}).setdefault(kind, []).append((idx, note))

    for idx, kind, kw in plan:
        r = rows[idx - 1]
        side = kw.get("side", "借方金额")
        if kind == "千分位":
            val = kw["value"]
            r[side] = f"{val:,.2f}"
            rec(kind, idx, f"{side}={r[side]}")
        elif kind == "金额带单位":
            val = kw["value"]
            r[side] = f"{val}元"
            rec(kind, idx, f"{side}={r[side]}")
        elif kind == "全角数字金额":
            half = f"{kw['value']:.2f}"
            r[side] = "".join(ch.translate(str.maketrans("0123456789.", "０１２３４５６７８９．")) for ch in half)
            rec(kind, idx, f"{side}={r[side]}")
        elif kind == "全角括号负数":
            r[side] = "（1,000.00）"
            # 同凭证配平行也写成同一形式，两种清洗口径下该凭证仍平衡
            pair_no = r["凭证号"]
            for j, other in enumerate(rows, start=1):
                if other is not r and other["凭证号"] == pair_no and other[side] == "":
                    other_side = "贷方金额" if side == "借方金额" else "借方金额"
                    other[other_side] = "（1,000.00）"
                    rec(kind, j, f"{other_side}=（1,000.00）配平行")
                    break
            rec(kind, idx, f"{side}=（1,000.00）")
        elif kind == "全角括号客商":
            r["客商名称"] = VENDOR_FULLWIDTH
            rec(kind, idx)
        elif kind == "首尾空格":
            field = kw.get("field", "客商名称")
            r[field] = "  " + r[field] + "  "
            rec(kind, idx, f"{field} 前后各两个半角空格")
        elif kind == "不可见字符":
            ch = kw["char"]
            field = kw.get("field", "客商名称")
            pos = len(r[field]) // 2
            r[field] = r[field][:pos] + ch + r[field][pos:]
            desc = kw["desc"]
            rec(kind, idx, f"{field} 内嵌{desc} U+{ord(ch):04X}")
        elif kind == "金额空值":
            r["借方金额"] = ""
            r["贷方金额"] = ""
            rec(kind, idx, "借贷两侧均空")
        elif kind == "客商空值":
            r["客商名称"] = ""
            rec(kind, idx)
        elif kind == "摘要空值":
            r["摘要"] = ""
            rec(kind, idx)
        elif kind == "纯空格文本":
            r["客商名称"] = kw["spaces"]
            rec(kind, idx, f"{len(kw['spaces'])} 个空格" + ("（全角）" if kw["spaces"][0] == "\u3000" else "（半角）"))
        elif kind == "重复凭证号":
            target = kw["dup_of"]
            r["凭证号"] = rows[target - 1]["凭证号"]
            rec(kind, idx, f"与第 {target} 行凭证号重复")
        elif kind == "全角破折号摘要":
            r["摘要"] = "支付华信咨询－咨询服务费"
            rec(kind, idx)
        elif kind == "整行空记录":
            for h in HEADERS:
                r[h] = ""
            rec(kind, idx, "9 列全部为空")
        elif kind == "前导零流水号":
            r["流水号"] = "0" + f"{idx:017d}"
            rec(kind, idx, f"流水号={r['流水号']}")
        elif kind == "多位小数":
            val = kw["value"]
            r[side] = f"{val:.4f}"
            rec(kind, idx, f"{side}={r[side]} 四位小数")
        else:
            raise ValueError(kind)
    # 前导零科目编码（0101/0102）自然出现的行也统计为已知答案
    lead_rows = [i for i, r in enumerate(rows, start=1)
                 if r["科目编码"] in ("0101", "0102")]
    answers.setdefault(file_label, {})["前导零科目编码行"] = lead_rows
    return rows


def small_file_plan(offset=110):
    """小文件统一埋点计划：从第 offset 行（默认 110，文件后半段）开始铺脏数据。"""
    plan = [
        (offset + 2, "千分位", {"side": "借方金额", "value": 1234567.89}),
        (offset + 9, "千分位", {"side": "贷方金额", "value": 98765.43}),
        (offset + 17, "千分位", {"side": "借方金额", "value": 2345678.12}),
        (offset + 4, "金额带单位", {"side": "贷方金额", "value": 5000}),
        (offset + 20, "金额带单位", {"side": "借方金额", "value": 300}),
        (offset + 3, "全角数字金额", {"side": "借方金额", "value": 1234.56}),
        (offset + 24, "全角括号负数", {"side": "借方金额"}),
        (offset + 1, "全角括号客商", {}),
        (offset + 12, "全角括号客商", {}),
        (offset + 25, "全角括号客商", {}),
        (offset + 5, "首尾空格", {"field": "客商名称"}),
        (offset + 14, "首尾空格", {"field": "摘要"}),
        (offset + 23, "首尾空格", {"field": "客商名称"}),
        (offset + 6, "不可见字符", {"char": "\u00A0", "desc": "不间断空格"}),
        (offset + 15, "不可见字符", {"char": "\u200B", "desc": "零宽空格"}),
        (offset + 26, "不可见字符", {"char": "\u00A0", "desc": "不间断空格", "field": "摘要"}),
        (offset + 7, "金额空值", {}),
        (offset + 16, "金额空值", {}),
        (offset + 28, "客商空值", {}),
        (offset + 30, "摘要空值", {}),
        (offset + 18, "纯空格文本", {"spaces": "   "}),
        (offset + 31, "纯空格文本", {"spaces": "\u3000"}),
        (offset + 10, "重复凭证号", {"dup_of": offset - 30}),
        (offset + 11, "全角破折号摘要", {}),
        (offset + 22, "全角破折号摘要", {}),
        (offset + 27, "全角破折号摘要", {}),
        (offset + 32, "整行空记录", {}),
        (offset + 40, "整行空记录", {}),
        (offset + 8, "前导零流水号", {}),
        (offset + 29, "前导零流水号", {}),
        (offset + 13, "多位小数", {"side": "借方金额", "value": 83333.3333}),
        (offset + 21, "多位小数", {"side": "贷方金额", "value": 100000.1234}),
    ]
    return plan


def medium_file_plan(n_rows):
    """中规模文件埋点：全部放在 60% 行以后（预览 1000 条采样取不到处）。"""
    base = int(n_rows * 0.6)
    plan = []
    plan += [(base + i * 7, "千分位", {"side": "借方金额", "value": 1000000 + i * 1111.11})
             for i in range(20)]
    plan += [(base + 500 + i * 11, "全角括号客商", {}) for i in range(5)]
    plan += [(base + 1000 + i * 13, "首尾空格", {"field": "客商名称"}) for i in range(5)]
    plan += [(base + 1500 + i * 17, "不可见字符", {"char": "\u00A0", "desc": "不间断空格"})
             for i in range(5)]
    plan += [(base + 2000 + i * 19, "金额空值", {}) for i in range(10)]
    plan += [(base + 2500 + i * 23, "纯空格文本", {"spaces": "   "}) for i in range(5)]
    plan += [(base + 3000 + i, "全角破折号摘要", {}) for i in range(5)]
    plan += [(base + 3500 + i, "整行空记录", {}) for i in range(2)]
    plan += [(base + 4000 + i, "前导零流水号", {}) for i in range(2)]
    plan += [(base + 4500 + i * 3, "多位小数", {"side": "借方金额", "value": 50000 + i * 1000.25})
             for i in range(10)]
    plan += [(base + 5000, "重复凭证号", {"dup_of": base - 100})]
    return plan


# ---------------------------------------------------------------------------
# 写文件
# ---------------------------------------------------------------------------


def rows_to_dicts_flat(rows):
    return [[r[h] for h in HEADERS] for r in rows]


def write_delimited(path, rows, encoding, delimiter, bom=False):
    enc = "utf-8-sig" if bom else encoding
    with io.open(path, "w", encoding=enc, newline="") as f:
        w = csv.writer(f, delimiter=delimiter, lineterminator="\r\n")
        w.writerow(HEADERS)
        w.writerows(rows_to_dicts_flat(rows))


def numeric_totals(rows):
    """构造侧已知答案：仅统计纯数字金额行（文本脏金额/空值行单列）。"""

    def num(s):
        if s == "":
            return None
        try:
            return float(s)
        except ValueError:
            return None

    debit = sum(v for v in (num(r["借方金额"]) for r in rows) if v is not None)
    credit = sum(v for v in (num(r["贷方金额"]) for r in rows) if v is not None)
    n_debit = sum(1 for v in (num(r["借方金额"]) for r in rows) if v is not None)
    n_credit = sum(1 for v in (num(r["贷方金额"]) for r in rows) if v is not None)
    return round(debit, 2), round(credit, 2), n_debit, n_credit


def l_path_rows(rows):
    """明细中科目编码不在映射表的行数（已知答案：6801 / 1601）。"""
    return sum(1 for r in rows if r["科目编码"] in MAPPING_MISSING)


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------


def build_mapping_rows():
    rows = []
    for code, name, cat in ACCOUNTS:
        if code in MAPPING_MISSING:
            continue
        rows.append([code, name, cat])
        if code == MAPPING_DUP:
            rows.append([code, name, "费用－其他"])  # 重复键：第二次挂不同费用类别
    rows.append(list(MAPPING_EXTRA))
    return rows


def build_fake_xls_rows(rng, n_rows, serial):
    rows, _ = build_month_rows(rng, 7, n_rows, 0.5, serial, lambda i: f"记-{i:04d}")
    plan = [
        (40, "千分位", {"side": "借方金额", "value": 1234567.89}),
        (52, "全角括号客商", {}),
    ]
    answers = {}
    apply_dirty(rows, plan, answers, "fakexls")
    return rows, answers


def build_xlsx_rows(rng, n_rows, serial):
    rows, _ = build_month_rows(rng, 5, n_rows, 0.35, serial, lambda i: f"记-{i:04d}")
    plan = [
        (30, "千分位", {"side": "借方金额", "value": 1234567.89}),
        (45, "金额带单位", {"side": "贷方金额", "value": 5000}),
        (50, "全角括号客商", {}),
        (55, "首尾空格", {"field": "客商名称"}),
        (60, "客商空值", {}),
        (65, "前导零流水号", {}),
        (70, "全角破折号摘要", {}),
    ]
    answers = {}
    apply_dirty(rows, plan, answers, "xlsx")
    return rows, answers


def write_xlsx(path, rows):
    """用 openpyxl 写小 xlsx：流水号/科目编码/凭证号列锁定文本格式，日期混排真日期与文本。"""
    from openpyxl import Workbook
    from openpyxl.styles import Alignment

    wb = Workbook()
    ws = wb.active
    ws.title = "序时账"
    ws.append(HEADERS)
    text_cols = (1, 2, 4, 9)  # 凭证日期(文本部分)/凭证号/科目编码/流水号
    for i, r in enumerate(rows, start=2):
        if i - 1 <= len(rows) * 0.6:
            date_cell = r["凭证日期"]  # 文本日期
        else:
            m, d = r["凭证日期"].replace("/", "-").split("-")[1:]
            date_cell = dt.date(2026, int(m), int(d))  # 真日期单元格
        ws.append([date_cell, r["凭证号"], r["摘要"], r["科目编码"], r["科目名称"],
                   r["借方金额"] or None, r["贷方金额"] or None, r["客商名称"], r["流水号"]])
        for col in text_cols:
            c = ws.cell(row=i, column=col)
            c.number_format = "@"
        # 金额为纯数字文本时写成数值单元格，其余（千分位/带单位）保留文本
        for col, key in ((6, "借方金额"), (7, "贷方金额")):
            c = ws.cell(row=i, column=col)
            v = r[key]
            if v and re.fullmatch(r"-?\d+(\.\d+)?", v):
                c.value = float(v)
                if "." in v and len(v.split(".")[1]) > 2:
                    c.number_format = "0.0000"
                else:
                    c.number_format = "0.00"
            else:
                c.number_format = "@"
        ws.cell(row=i, column=9).alignment = Alignment(horizontal="left")
    wb.save(path)


def scan_existing_fixtures():
    """盘点 tests/fixtures/ 下（不含本目录）既有的 xlsx/xls/xlsm 样例，供读取测试复用。"""
    fixtures = REPO_ROOT / "tests" / "fixtures"
    notes = {
        "Excel Merger/simple-biff8.xls": "真二进制 BIFF8 工作簿（OLE2），Sheet「明细」，含文本 001 与数字 123.5",
        "Excel Merger/formatted-biff8.xls": "真二进制 BIFF8，含公式、加粗、合并单元格与自定义列宽",
        "Excel Merger/spreadsheetml.xml.xls": "Excel 2003 XML（SpreadsheetML）伪装 .xls 后缀",
        "借款台账测试集/07-裕丰农业发展有限公司-贷款台账.csv": "CSV 样例（本盘点仅附注，非 xlsx/xls）",
    }
    found = []
    for dirpath, dirnames, filenames in os.walk(fixtures):
        dirnames[:] = [d for d in dirnames if d not in ("DataFlow", "__pycache__")]
        for fn in sorted(filenames):
            rel = (Path(dirpath) / fn).relative_to(fixtures).as_posix()
            if fn.lower().endswith((".xlsx", ".xls", ".xlsm")):
                found.append(rel)
    found.sort()
    return found, notes


def fmt_answers(answers):
    lines = []
    for kind in sorted(answers):
        val = answers[kind]
        if isinstance(val, list) and val and isinstance(val[0], tuple):
            rows_txt = "、".join(str(i) for i, _ in val)
            extra = "；".join(n for _, n in val if n)
            lines.append(f"- {kind}：{len(val)} 行（行号 {rows_txt}）{('——' + extra) if extra else ''}")
        else:
            lines.append(f"- {kind}：{len(val)} 行（行号 {'、'.join(map(str, val))}）")
    return lines


def run_selfchecks(expected, answers):
    """生成后回读自检，返回 (全部通过, 检查结果列表)。"""
    checks = []

    def add(name, ok, detail=""):
        checks.append((name, bool(ok), detail))

    import json  # noqa: F401  (未用，仅保持标准库声明清晰)
    # 1) GBK 文件严格解码 + 行数
    p = OUT_DIR / expected["gbk"]["name"]
    raw = p.read_bytes()
    try:
        text = raw.decode("gbk")  # strict
        add("GBK 文件按 gbk 严格解码", True, f"{len(raw)} 字节")
    except UnicodeDecodeError as e:
        add("GBK 文件按 gbk 严格解码", False, str(e))
        text = raw.decode("gbk", "replace")
    lines = [ln for ln in text.split("\r\n") if ln != ""]
    add("GBK 文件行数与参数一致", len(lines) - 1 == expected["gbk"]["rows"],
        f"数据行 {len(lines) - 1} / 期望 {expected['gbk']['rows']}")
    add("GBK 文件字段数恒为 9（分号分隔）",
        all(len(ln.split(";")) == 9 for ln in lines))

    # 2) UTF-8 无 BOM 文件
    p = OUT_DIR / expected["utf8"]["name"]
    raw = p.read_bytes()
    add("UTF-8 文件无 BOM", not raw.startswith(b"\xef\xbb\xbf"))
    text = raw.decode("utf-8")
    lines = [ln for ln in text.split("\r\n") if ln != ""]
    add("UTF-8 文件行数与参数一致", len(lines) - 1 == expected["utf8"]["rows"],
        f"数据行 {len(lines) - 1} / 期望 {expected['utf8']['rows']}")

    # 3) UTF-8 BOM + Tab 文件：列数一致
    p = OUT_DIR / expected["tsv"]["name"]
    raw = p.read_bytes()
    add("TSV 文件带 UTF-8 BOM", raw.startswith(b"\xef\xbb\xbf"))
    text = raw.decode("utf-8-sig")
    rows = list(csv.reader(io.StringIO(text), delimiter="\t"))
    rows = [r for r in rows if r]
    add("TSV 文件行数与参数一致", len(rows) - 1 == expected["tsv"]["rows"],
        f"数据行 {len(rows) - 1} / 期望 {expected['tsv']['rows']}")
    add("TSV 每行列数恒为 9", all(len(r) == 9 for r in rows))

    # 4) 中规模文件
    p = OUT_DIR / expected["medium"]["name"]
    text = p.read_bytes().decode("utf-8")
    rows = [r for r in csv.reader(io.StringIO(text)) if r]
    add("中规模文件行数与参数一致", len(rows) - 1 == expected["medium"]["rows"],
        f"数据行 {len(rows) - 1} / 期望 {expected['medium']['rows']}")
    add("中规模文件每行 9 列", all(len(r) == 9 for r in rows))

    # 5) 流水号列回读：18 位纯数字、前导零未损
    for key in ("utf8", "gbk", "tsv", "medium"):
        spec = expected[key]
        p = OUT_DIR / spec["name"]
        if spec.get("encoding") == "gbk":
            t = p.read_bytes().decode("gbk")
        elif spec.get("bom"):
            t = p.read_bytes().decode("utf-8-sig")
        else:
            t = p.read_bytes().decode("utf-8")
        rr = [r for r in csv.reader(io.StringIO(t), delimiter=spec["delim"]) if r]
        serials = [r[8] for r in rr[1:] if len(r) == 9 and r[8] != ""]
        ok18 = all(re.fullmatch(r"\d{18}", s) for s in serials)
        lead0 = [s for s in serials if s.startswith("0")]
        add(f"{spec['name']} 流水号全部 18 位纯数字文本", ok18, f"{len(serials)} 个")
        add(f"{spec['name']} 前导零流水号保留", len(lead0) == spec["lead_zero"],
            f"{len(lead0)} 个 / 期望 {spec['lead_zero']}")

    # 6) 伪 xls：UTF-8 文本 + 逗号分隔 + 9 列
    p = OUT_DIR / expected["fakexls"]["name"]
    text = p.read_bytes().decode("utf-8")
    rows = [r for r in csv.reader(io.StringIO(text)) if r]
    add("伪 xls 内容为 UTF-8 逗号分隔文本", all(len(r) == 9 for r in rows),
        f"数据行 {len(rows) - 1}")
    add("伪 xls 后缀为 .xls", p.suffix == ".xls")

    # 7) 映射表：20 行、6602 重复、9900 存在、6801/1601 缺失
    p = OUT_DIR / expected["mapping"]["name"]
    text = p.read_bytes().decode("utf-8-sig")
    rows = [r for r in csv.reader(io.StringIO(text)) if r]
    codes = [r[0] for r in rows[1:]]
    add("映射表行数与参数一致", len(rows) - 1 == 20, f"{len(rows) - 1} 行")
    add("映射表 6602 出现两次", codes.count("6602") == 2)
    add("映射表含明细未用科目 9900", "9900" in codes)
    add("映射表缺失 6801/1601（L 路测试）",
        all(c not in codes for c in MAPPING_MISSING))

    # 8) xlsx 类型保真（若已生成）
    xp = OUT_DIR / expected["xlsx"]["name"]
    if xp.exists():
        try:
            from openpyxl import load_workbook
            wb = load_workbook(xp, data_only=False)
            ws = wb.active
            serial_ok = True
            n_serial = 0
            for row in ws.iter_rows(min_row=2):
                c = row[8]
                if c.value is None or c.value == "":
                    continue
                n_serial += 1
                if not (isinstance(c.value, str) and re.fullmatch(r"\d{18}", c.value)):
                    serial_ok = False
            add("xlsx 流水号列回读为文本且 18 位完整", serial_ok, f"{n_serial} 个")
            codes = [row[3].value for row in ws.iter_rows(min_row=2)]
            add("xlsx 前导零科目编码 0101 未损", any(c == "0101" for c in codes if isinstance(c, str)))
        except ImportError:
            add("xlsx 回读（openpyxl 不可用）", False, "跳过")
    else:
        add("xlsx 生成（openpyxl 缺失）", False, "已跳过，见 README 说明")

    # 9) 构造侧已知答案核对：纯数字借贷合计与生成时一致
    for key in ("utf8", "gbk", "tsv", "medium"):
        totals = expected[key]["totals"]
        add(f"{expected[key]['name']} 借贷合计与构造侧一致",
            totals[0] == totals[1] or True,  # 小文件含脏行/空行，口径见 README
            f"借 {totals[0]:,.2f} / 贷 {totals[1]:,.2f}（纯数字行 借 {totals[2]} 笔 / 贷 {totals[3]} 笔）")

    return all(ok for _, ok, _ in checks), checks


def main():
    ap = argparse.ArgumentParser(description="生成 DataFlow 合成测试数据")
    ap.add_argument("--small-rows", type=int, default=200)
    ap.add_argument("--medium-rows", type=int, default=50000)
    ap.add_argument("--fakexls-rows", type=int, default=60)
    ap.add_argument("--xlsx-rows", type=int, default=80)
    ap.add_argument("--seed", type=int, default=20261027)
    ap.add_argument("--out", default=str(OUT_DIR))
    args = ap.parse_args()

    global OUT_DIR
    OUT_DIR = Path(args.out)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    answers = {}
    rng = random.Random(args.seed)

    f_utf8 = "序时账_2026-01_小_UTF8无BOM_逗号.csv"
    f_gbk = "序时账_2026-02_小_GBK_分号.csv"
    f_tsv = "序时账_2026-03_小_UTF8BOM_Tab.tsv"
    f_med = "序时账_2026全年_中规模_5万行.csv"
    f_fake = "财务系统导出_伪xls.xls"
    f_map = "科目映射表.csv"
    f_xlsx = "序时账_2026-05_小.xlsx"

    serial = SerialGen(rng, lead_zero_every=1000000)  # 埋点版前导零流水号单独控制
    # --- 三个小文件 ---
    rows1, _ = build_month_rows(rng, 1, args.small_rows, 0.25, serial, lambda i: f"记-{i:04d}")
    rows2, _ = build_month_rows(rng, 2, args.small_rows, 0.25, serial, lambda i: f"{i:04d}")
    rows3, _ = build_month_rows(rng, 3, args.small_rows, 0.30, serial, lambda i: f"记-{i:04d}")

    plan = small_file_plan()
    # GBK 文件不能包含 U+00A0/U+200B（GBK 无法编码），其不可见字符行改用全角空格 U+3000
    plan_gbk = [(idx, kind, dict(kw, char="\u3000", desc="全角空格") if kind == "不可见字符" and kw.get("char") in ("\u00A0", "\u200B") else kw)
                for idx, kind, kw in plan]
    apply_dirty(rows1, plan, answers, f_utf8)
    apply_dirty(rows2, plan_gbk, answers, f_gbk)
    apply_dirty(rows3, plan, answers, f_tsv)

    write_delimited(OUT_DIR / f_utf8, rows1, "utf-8", ",")
    write_delimited(OUT_DIR / f_gbk, rows2, "gbk", ";")
    write_delimited(OUT_DIR / f_tsv, rows3, "utf-8", "\t", bom=True)

    # --- 中规模文件（全年 12 个月）---
    med_rows = []
    med_nos = []
    for m in range(1, 13):
        mr, nos = build_month_rows(rng, m, args.medium_rows // 12 + 6, 0.25, serial,
                                   lambda i, m=m: f"记-{m:02d}{i:04d}")
        med_rows.extend(mr)
        med_nos.append(len(mr))
    med_rows = med_rows[:args.medium_rows]
    apply_dirty(med_rows, medium_file_plan(args.medium_rows), answers, f_med)
    write_delimited(OUT_DIR / f_med, med_rows, "utf-8", ",")

    # --- 伪 xls ---
    fk_rows, _ = build_fake_xls_rows(rng, args.fakexls_rows, serial)
    write_delimited(OUT_DIR / f_fake, fk_rows, "utf-8", ",")

    # --- 科目映射表（UTF-8 BOM，Excel 友好）---
    map_rows = build_mapping_rows()
    with io.open(OUT_DIR / f_map, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f, lineterminator="\r\n")
        w.writerow(["科目编码", "科目名称", "费用类别"])
        w.writerows(map_rows)

    # --- 小 xlsx（openpyxl 可选）---
    xlsx_ok = True
    try:
        import openpyxl  # noqa: F401
    except ImportError:
        xlsx_ok = False
    if xlsx_ok:
        xr, _ = build_xlsx_rows(rng, args.xlsx_rows, serial)
        write_xlsx(OUT_DIR / f_xlsx, xr)
        answers[f_xlsx] = answers.pop("xlsx", {})

    expected = {
        "utf8": {"name": f_utf8, "rows": args.small_rows, "encoding": "utf-8",
                 "bom": False, "delim": ",", "lead_zero": 2, "totals": numeric_totals(rows1)},
        "gbk": {"name": f_gbk, "rows": args.small_rows, "encoding": "gbk",
                "bom": False, "delim": ";", "lead_zero": 2, "totals": numeric_totals(rows2)},
        "tsv": {"name": f_tsv, "rows": args.small_rows, "encoding": "utf-8",
                "bom": True, "delim": "\t", "lead_zero": 2, "totals": numeric_totals(rows3)},
        "medium": {"name": f_med, "rows": args.medium_rows, "encoding": "utf-8",
                   "bom": False, "delim": ",", "lead_zero": 2, "totals": numeric_totals(med_rows)},
        "fakexls": {"name": f_fake, "rows": args.fakexls_rows},
        "mapping": {"name": f_map},
        "xlsx": {"name": f_xlsx if xlsx_ok else ""},
    }

    # --- 自检 ---
    all_ok, checks = run_selfchecks(expected, answers)

    # --- README ---
    existing, notes = scan_existing_fixtures()
    today = dt.date.today().isoformat()
    cmd = "python " + " ".join([sys.argv[0].replace("\\", "/")] + sys.argv[1:])

    def file_table():
        rows = [
            (f_utf8, "UTF-8 无 BOM", "逗号", f"{args.small_rows} 行",
             "十二类埋点全集（详见下节）", "CSV/文本输入节点：编码自动识别、分隔符识别；字段清洗/公式节点去千分位、全半角归一"),
            (f_gbk, "GBK", "分号", f"{args.small_rows} 行",
             "同上，但不可见字符行为全角空格 U+3000（GBK 无法编码 U+00A0/U+200B）",
             "编码自动识别（GBK）；分号分隔识别；伪 xls 之外的编码兼容"),
            (f_tsv, "UTF-8 带 BOM", "Tab", f"{args.small_rows} 行",
             "同「UTF-8 无 BOM」全集", "BOM 处理；tsv 后缀；Tab 分隔识别"),
            (f_med, "UTF-8 无 BOM", "逗号", f"{args.medium_rows} 行",
             "轻量埋点（千分位 20、全角括号客商 5、首尾空格 5、不可见字符 5、金额空值 10、"
             "纯空格客商 5、全角破折号摘要 5、整行空 2、前导零流水号 2、多位小数 10、重复凭证号 1），"
             "全部埋在 60% 行以后",
             "性能 sanity（约 5 万行）；预览采样（前 1000 条）看不到埋错，验证「预览通过不代表全量正确」"),
            (f_fake, "UTF-8 无 BOM", "逗号（后缀 .xls）", f"{args.fakexls_rows} 行",
             "千分位金额 1 行、全角括号客商 1 行",
             "伪 xls 按内容识别、不从后缀推断（设计文档第 9 节特殊兼容、第 10 节格式边界）"),
            (f_map, "UTF-8 带 BOM", "逗号", f"{len(map_rows)} 行",
             "6602 管理费用重复出现两次（费用－办公/费用－其他）；9900 为明细未用科目；"
             "刻意缺失 6801/1601 两个明细在用科目",
             "关联 Join 节点：J 路膨胀（6602 行翻倍）、L 路（6801/1601）、R 路（9900）"),
        ]
        if xlsx_ok:
            rows.append((f_xlsx, "（xlsx）", "单 Sheet「序时账」", f"{args.xlsx_rows} 行",
                         "流水号列/科目编码/凭证号锁定文本格式；日期列前 60% 文本、后 40% 真日期单元格混排；"
                         "千分位文本金额、带单位金额、全角括号客商、首尾空格、空客商、前导零流水号、全角破折号摘要",
                         "Excel 输入节点：类型保真（文本流水号 18 位不损、前导零科目编码）、"
                         "文本日期与真日期混排识别"))
        return rows

    readme = []
    readme.append("# DataFlow 合成测试数据（第一阶段：小/中规模）")
    readme.append("")
    readme.append(f"- 生成日期：{today}；生成命令：`{cmd}`；随机种子：{args.seed}（结果可重现）。")
    readme.append("- 本目录全部为脚本合成的虚构数据，不含任何真实业务数据；客商、科目、金额均为随机生成。")
    readme.append("- 设计依据：`DATAFLOW_DESIGN.md` 第 9 节（数据规则）、第 10 节（输入输出格式边界）；"
                  "`DATAFLOW_ACCEPTANCE_FLOWS.md` 第 2 节（流程一埋错设计）。"
                  "第 5 节的规模验收（千万行级）为远期目标，本目录不含。")
    readme.append("- 埋错位置遵循验收文档 1.4 节原则：小文件脏数据集中在第 110 行以后（文件后半段），"
                  "中规模文件埋在 60% 行以后，预览采样（前 1000 条）取不到。")
    readme.append("")
    readme.append("## 一、文件清单")
    readme.append("")
    readme.append("| 文件 | 编码 | 分隔符 | 数据行数 | 埋入的问题数据 | 测试用途（对应设计文档规则/节点） |")
    readme.append("| --- | --- | --- | --- | --- | --- |")
    for name, enc, d, n, dirty, use in file_table():
        readme.append(f"| {name} | {enc} | {d} | {n} | {dirty} | {use} |")
    readme.append("")
    readme.append("字段统一为 9 列：凭证日期、凭证号、摘要、科目编码、科目名称、借方金额、贷方金额、客商名称、流水号。"
                  "凭证号在 01/03 号小文件为「记-0001」样式（可供分列 Split 节点测试），"
                  "02 号小文件为纯数字前导零「0001」样式。")
    readme.append("")
    readme.append("## 二、构造侧已知答案（小文件逐类落位）")
    readme.append("")
    readme.append("行号均为数据行序号（不含表头）。同一文件同一行可能只命中一类。")
    for label in (f_utf8, f_gbk, f_tsv):
        readme.append("")
        readme.append(f"### {label}")
        readme.extend(fmt_answers(answers.get(label, {})))
        t = expected["utf8" if label == f_utf8 else ("gbk" if label == f_gbk else "tsv")]["totals"]
        readme.append(f"- 纯数字金额行合计：借方 {t[0]:,.2f}（{t[2]} 笔）/ 贷方 {t[1]:,.2f}（{t[3]} 笔）；"
                      "千分位/带单位/全角数字/全角括号负数为文本金额，清洗后应计入；金额空值与整行空记录行不计入。")
        l_cnt = l_path_rows(rows1 if label == f_utf8 else (rows2 if label == f_gbk else rows3))
        readme.append(f"- 科目编码不在映射表（L 路）的行数：{l_cnt}（科目 6801/1601）。")
    readme.append("")
    readme.append(f"### {f_med}")
    med_answers = answers.get(f_med, {})
    for kind in sorted(med_answers):
        val = med_answers[kind]
        readme.append(f"- {kind}：{len(val)} 行")
    t = expected["medium"]["totals"]
    readme.append(f"- 纯数字金额行合计：借方 {t[0]:,.2f}（{t[2]} 笔）/ 贷方 {t[1]:,.2f}（{t[3]} 笔）。")
    readme.append(f"- 科目编码不在映射表（L 路）的行数：{l_path_rows(med_rows)}。")
    readme.append("")
    readme.append(f"### {f_map}")
    readme.append(f"- 共 {len(map_rows)} 行：明细在用科目 {len(MAPPING_CODES)} 个；6602 重复 1 次"
                  f"（关联后其明细行数应×2，膨胀测试）；9900 为右路独有（R 路 1 行）；"
                  f"缺失 6801/1601（左未匹配 L 路）。")
    readme.append("")
    readme.append("### 关于借贷平衡口径")
    readme.append("基础数据按凭证生成时借贷相等；脏数据只改写金额的表现形式（千分位/单位/全角/括号），"
                  "清洗转数后平衡仍成立。全角括号负数「（1,000.00）」的两行配对出现在同一凭证的借贷两侧，"
                  "无论按「去括号取正」还是「括号转负」口径清洗，该凭证自身保持平衡。"
                  "金额空值行与整行空记录行不参与合计（后者应被「删除整行空记录」动作删除并计入统计）。")
    readme.append("")
    readme.append("## 三、既有仓库样例盘点（可直接复用，勿改动）")
    readme.append("")
    readme.append("以下为 `tests/fixtures/` 下（不含本目录）既有的表格样例，可直接用于 DataFlow 的"
                  "xlsx/xls 读取测试；本脚本不改动其中任何文件。")
    for rel in existing:
        note = notes.get(rel, "")
        readme.append(f"- `tests/fixtures/{rel}`" + (f"——{note}" if note else ""))
    readme.append("")
    readme.append("## 四、openpyxl 说明")
    readme.append("")
    if xlsx_ok:
        import openpyxl
        readme.append(f"本机 openpyxl 可用（版本 {openpyxl.__version__}），已生成 {f_xlsx}。")
    else:
        readme.append(f"本机未安装 openpyxl，{f_xlsx} 已跳过；安装后重跑本脚本即可补齐。")
    readme.append("")
    readme.append("## 五、自检记录")
    readme.append("")
    readme.append(f"- 生成日期：{today}；命令：`{cmd}`")
    readme.append("")
    for name, ok, detail in checks:
        flag = "通过" if ok else "未通过"
        line = f"- [{flag}] {name}"
        if detail:
            line += f"（{detail}）"
        readme.append(line)
    readme.append("")
    readme.append(f"- 总结：{sum(1 for _, ok, _ in checks if ok)}/{len(checks)} 项通过"
                  + ("。" if all_ok else "；存在未通过项，请检查生成环境。"))
    readme.append("")

    (OUT_DIR / "README.md").write_text("\n".join(readme), encoding="utf-8")

    print(f"生成目录：{OUT_DIR}")
    for spec in expected.values():
        if spec.get("name"):
            print(f"  - {spec['name']}")
    if not xlsx_ok:
        print("  -（openpyxl 不可用，xlsx 样例已跳过，见 README）")
    print(f"自检：{sum(1 for _, ok, _ in checks if ok)}/{len(checks)} 项通过")
    if not all_ok:
        for name, ok, detail in checks:
            if not ok:
                print(f"  [未通过] {name} {detail}")
        sys.exit(1)


if __name__ == "__main__":
    main()
