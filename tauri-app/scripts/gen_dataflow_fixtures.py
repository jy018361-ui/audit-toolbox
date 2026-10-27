# -*- coding: utf-8 -*-
"""生成「数据流 DataFlow」工具的合成测试数据（tests/fixtures/DataFlow/）。

数据来源：全部由本脚本随机合成（固定随机种子，可重现），不含任何真实业务数据。
设计依据：
  - DATAFLOW_DESIGN.md 第 9 节（数据规则）、第 10 节（输入输出格式边界）；
  - DATAFLOW_ACCEPTANCE_FLOWS.md 第 2 节（流程一·批量清洗合并的埋错设计）；
  - 第 5 节为远期规模验收方案，本次仅生成小/中规模（约 200 行/文件 与 约 5 万行）。

仅使用 Python 标准库；唯一的可选用依赖是 openpyxl（用于生成一个小 xlsx 样例，
未安装时自动跳过并在 README 中说明）。重跑会覆盖本目录内同名文件，不改动仓库其他文件。

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
DEFAULT_OUT = REPO_ROOT / "tests" / "fixtures" / "DataFlow"

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
VENDOR_FULLWIDTH = "华信咨询（上海）有限公司"  # 全角括号脏写法（清洗后应与半角写法归一）

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
    """18 位银行流水号生成器：普通号以 62 开头；前导零变体由埋点计划单独写入。"""

    def __init__(self):
        self.count = 0

    def next(self) -> str:
        self.count += 1
        return "62" + f"{self.count:016d}"


def make_voucher_rows(rng: random.Random, month: int, voucher_no: str,
                      slash_date_ratio: float, serial: SerialGen):
    """生成一张借贷平衡的凭证（2~4 行），返回行列表（dict）。

    slash_date_ratio: 使用斜杠短写日期（如 2026/1/3）的概率，其余用 2026-01-03。
    """
    day = rng.randint(1, 28)
    if rng.random() < slash_date_ratio:
        date_str = f"2026/{month}/{day}"
    else:
        date_str = f"2026-{month:02d}-{day:02d}"
    n_lines = rng.choice([2, 2, 2, 3, 3, 4])
    total = round(rng.uniform(500, 400000), 2)
    debit_first = rng.random() < 0.5
    splits = [round(total / (n_lines - 1), 2)] * (n_lines - 1)
    splits[-1] = round(total - sum(splits[:-1]), 2)
    rows = []
    for i in range(n_lines):
        code, name, _ = ACCOUNTS[rng.randrange(len(ACCOUNTS))]
        vendor = VENDORS[rng.randrange(len(VENDORS))]
        abstract = ABSTRACTS[rng.randrange(len(ABSTRACTS))]
        if i == 0:
            amount, is_debit = total, debit_first
        else:
            amount, is_debit = splits[i - 1], not debit_first
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


def build_month_rows(rng, month, n_rows, slash_date_ratio, serial, voucher_fmt):
    """生成某月 n_rows 行（截断到最后一张凭证的多余行），返回行列表。"""
    rows = []
    idx = 0
    while len(rows) < n_rows:
        idx += 1
        rows.extend(make_voucher_rows(rng, month, voucher_fmt(idx),
                                      slash_date_ratio, serial))
    return rows[:n_rows]


# ---------------------------------------------------------------------------
# 脏数据埋点（固定行号，集中在文件后半段：预览采样取不到的位置）
# ---------------------------------------------------------------------------


def apply_dirty(rows, plan, answers, file_label):
    """按计划把脏数据写进行列表，并把每类落位行号记入 answers（构造侧已知答案）。

    每行至多埋一类；「全角括号负数」在计划行号附近自适应寻找一张恰好两行、
    两侧金额相等的凭证，把借贷两侧同时写成「（1,000.00）」——这样无论清洗时
    按去括号取正还是按括号转负，该凭证自身都保持平衡。
    """
    fixed = {i for i, kind, _ in plan if kind != "全角括号负数"}
    used = set()

    def rec(kind, idx, note=""):
        answers.setdefault(file_label, {}).setdefault(kind, []).append((idx, note))

    for idx, kind, kw in plan:
        if kind == "全角括号负数":
            pos = _find_pair_voucher(rows, idx, fixed | used)
            a_i, b_i = pos
            rows[a_i - 1]["借方金额"] = "（1,000.00）"
            rows[b_i - 1]["贷方金额"] = "（1,000.00）"
            used.update(pos)
            rec(kind, a_i, "借方金额=（1,000.00）")
            rec(kind, b_i, "贷方金额=（1,000.00）配平行（同一凭证，两种清洗口径下该凭证均平衡）")
            continue
        if idx in used:
            raise RuntimeError(f"{file_label}: 第 {idx} 行被两种埋点占用")
        used.add(idx)
        r = rows[idx - 1]
        side = kw.get("side", "借方金额")
        if kind == "千分位":
            val = kw["value"]
            r[side] = f"{val:,.2f}"
            rec(kind, idx, f"{side}={r[side]}")
        elif kind == "金额带单位":
            r[side] = f"{kw['value']}元"
            rec(kind, idx, f"{side}={r[side]}")
        elif kind == "全角数字金额":
            half = f"{kw['value']:.2f}"
            table = str.maketrans("0123456789.", "０１２３４５６７８９．")
            r[side] = half.translate(table)
            rec(kind, idx, f"{side}={r[side]}")
        elif kind == "全角括号客商":
            r["客商名称"] = VENDOR_FULLWIDTH
            rec(kind, idx, f"客商名称={VENDOR_FULLWIDTH}")
        elif kind == "首尾空格":
            field = kw.get("field", "客商名称")
            r[field] = "  " + r[field] + "  "
            rec(kind, idx, f"{field} 前后各两个半角空格")
        elif kind == "不可见字符":
            ch = kw["char"]
            field = kw.get("field", "客商名称")
            pos = len(r[field]) // 2
            r[field] = r[field][:pos] + ch + r[field][pos:]
            rec(kind, idx, f"{field} 内嵌{kw['desc']} U+{ord(ch):04X}")
        elif kind == "金额空值":
            r["借方金额"] = ""
            r["贷方金额"] = ""
            rec(kind, idx, "借贷两侧均为空值")
        elif kind == "客商空值":
            r["客商名称"] = ""
            rec(kind, idx)
        elif kind == "摘要空值":
            r["摘要"] = ""
            rec(kind, idx)
        elif kind == "纯空格文本":
            r["客商名称"] = kw["spaces"]
            width = "全角" if kw["spaces"][0] == "\u3000" else "半角"
            rec(kind, idx, f"客商名称为 {len(kw['spaces'])} 个{width}空格（空文本之外的第三种形态）")
        elif kind == "重复凭证号":
            target = kw["dup_of"]
            r["凭证号"] = rows[target - 1]["凭证号"]
            rec(kind, idx, f"凭证号与第 {target} 行重复（不做拦截，仅供行数守恒核对）")
        elif kind == "全角破折号摘要":
            r["摘要"] = "支付华信咨询－咨询服务费"
            rec(kind, idx, "摘要含全角破折号 U+FF0D")
        elif kind == "整行空记录":
            for h in HEADERS:
                r[h] = ""
            rec(kind, idx, "9 列全部为空（供「删除整行空记录」动作测试）")
        elif kind == "前导零流水号":
            r["流水号"] = "0" + f"{idx:017d}"
            rec(kind, idx, f"流水号={r['流水号']}（前导零变体）")
        elif kind == "多位小数":
            r[side] = f"{kw['value']:.4f}"
            rec(kind, idx, f"{side}={r[side]} 四位小数（金额不统一截两位）")
        else:
            raise ValueError(kind)

    lead_rows = [i for i, r in enumerate(rows, start=1)
                 if r["科目编码"] in ("0101", "0102")]
    answers.setdefault(file_label, {})["前导零科目编码行"] = lead_rows
    slash_rows = [i for i, r in enumerate(rows, start=1)
                  if r["凭证日期"].startswith("2026/")]
    answers.setdefault(file_label, {})["斜杠短写日期行"] = slash_rows
    return rows


def _find_pair_voucher(rows, start_idx, exclude):
    """从 start_idx 起找一张恰好两行、两侧纯数字金额相等的凭证，返回两个行号（1 起）。"""
    for p in range(max(start_idx, 1), len(rows) + 1):
        if p in exclude:
            continue
        no = rows[p - 1]["凭证号"]
        group = [j for j, r in enumerate(rows, start=1) if r["凭证号"] == no]
        if len(group) != 2:
            continue
        if any(j in exclude for j in group):
            continue
        a, b = rows[group[0] - 1], rows[group[1] - 1]
        if a["借方金额"] and b["贷方金额"] and a["借方金额"] == b["贷方金额"]:
            return group[0], group[1]
        if b["借方金额"] and a["贷方金额"] and b["借方金额"] == a["贷方金额"]:
            return group[1], group[0]
    raise RuntimeError("未找到可用于全角括号负数的两行平衡凭证")


def small_file_plan(offset=110):
    """小文件统一埋点计划：从第 offset 行（默认 110，文件后半段）开始铺脏数据。"""
    return [
        (offset + 2, "千分位", {"side": "借方金额", "value": 1234567.89}),
        (offset + 9, "千分位", {"side": "贷方金额", "value": 98765.43}),
        (offset + 17, "千分位", {"side": "借方金额", "value": 2345678.12}),
        (offset + 4, "金额带单位", {"side": "贷方金额", "value": 5000}),
        (offset + 20, "金额带单位", {"side": "借方金额", "value": 300}),
        (offset + 3, "全角数字金额", {"side": "借方金额", "value": 1234.56}),
        (offset + 24, "全角括号负数", {}),
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


def medium_file_plan(n_rows):
    """中规模文件埋点：全部放在 60% 行以后（预览采样前 1000 条取不到处）。"""
    base = int(n_rows * 0.6)
    plan = []
    plan += [(base + 10 + i * 7, "千分位", {"side": "借方金额", "value": 1000000 + i * 1111.11})
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
# 写文件与已知答案
# ---------------------------------------------------------------------------


def write_delimited(path, rows, encoding, delimiter, bom=False):
    enc = "utf-8-sig" if bom else encoding
    with io.open(path, "w", encoding=enc, newline="") as f:
        w = csv.writer(f, delimiter=delimiter, lineterminator="\r\n")
        w.writerow(HEADERS)
        for r in rows:
            w.writerow([r[h] for h in HEADERS])


def numeric_totals(rows):
    """构造侧已知答案：仅统计纯数字金额（文本脏金额与空值不计入）。"""

    def num(s):
        try:
            return float(s)
        except (TypeError, ValueError):
            return None

    dv = [v for v in (num(r["借方金额"]) for r in rows) if v is not None]
    cv = [v for v in (num(r["贷方金额"]) for r in rows) if v is not None]
    return round(sum(dv), 2), round(sum(cv), 2), len(dv), len(cv)


def totals_from_flat(rows9):
    """回读自检用：与 numeric_totals 同口径，但输入是 9 列列表。"""

    def num(s):
        try:
            return float(s)
        except (TypeError, ValueError):
            return None

    dv = [v for v in (num(r[5]) for r in rows9) if v is not None]
    cv = [v for v in (num(r[6]) for r in rows9) if v is not None]
    return round(sum(dv), 2), round(sum(cv), 2), len(dv), len(cv)


def l_path_count(rows):
    return sum(1 for r in rows if r["科目编码"] in MAPPING_MISSING)


def build_mapping_rows():
    rows = []
    for code, name, cat in ACCOUNTS:
        if code in MAPPING_MISSING:
            continue
        rows.append([code, name, cat])
        if code == MAPPING_DUP:
            rows.append([code, name, "费用－其他"])
    rows.append(list(MAPPING_EXTRA))
    return rows


def write_xlsx(path, rows):
    """用 openpyxl 写小 xlsx：流水号/科目编码/凭证号列文本格式；日期前 60% 文本、后 40% 真日期。"""
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.title = "序时账"
    ws.append(HEADERS)
    n_text_date = int(len(rows) * 0.6)
    for i, r in enumerate(rows, start=1):
        if i <= n_text_date:
            date_cell = r["凭证日期"]  # 文本日期（含斜杠短写）
        else:
            m, d = r["凭证日期"].replace("/", "-").split("-")[1:]
            date_cell = dt.date(2026, int(m), int(d))  # 真日期单元格
        row_vals = [date_cell, r["凭证号"], r["摘要"], r["科目编码"], r["科目名称"],
                    r["借方金额"] or None, r["贷方金额"] or None, r["客商名称"], r["流水号"]]
        ws.append(row_vals)
        excel_row = i + 1
        # 文本锁定列：凭证号(2)/科目编码(4)/流水号(9)；日期列(1)仅文本日期锁文本格式
        for col in (2, 4, 9):
            ws.cell(row=excel_row, column=col).number_format = "@"
        if isinstance(date_cell, str):
            ws.cell(row=excel_row, column=1).number_format = "@"
        # 金额：纯数字写数值单元格（>2 位小数保留 4 位格式），千分位/带单位保留文本
        for col, key in ((6, "借方金额"), (7, "贷方金额")):
            c = ws.cell(row=excel_row, column=col)
            v = r[key]
            if v and re.fullmatch(r"-?\d+(\.\d+)?", v):
                c.value = float(v)
                c.number_format = "0.0000" if ("." in v and len(v.split(".")[1]) > 2) else "0.00"
            else:
                c.number_format = "@"
    wb.save(path)


def scan_existing_fixtures():
    """只读盘点 tests/fixtures/ 下（不含本目录）既有 xlsx/xls/xlsm 样例，供读取测试复用。"""
    fixtures = REPO_ROOT / "tests" / "fixtures"
    notes = {
        "Excel Merger/simple-biff8.xls": "真二进制 BIFF8 工作簿（OLE2），Sheet「明细」，含文本 001 与数字 123.5",
        "Excel Merger/formatted-biff8.xls": "真二进制 BIFF8，含公式、加粗、合并单元格与自定义列宽",
        "Excel Merger/spreadsheetml.xml.xls": "Excel 2003 XML（SpreadsheetML）内容、.xls 后缀",
    }
    found = []
    for dirpath, dirnames, filenames in os.walk(fixtures):
        dirnames[:] = [d for d in dirnames if d not in ("DataFlow", "__pycache__")]
        for fn in sorted(filenames):
            if fn.lower().endswith((".xlsx", ".xls", ".xlsm")):
                found.append((Path(dirpath) / fn).relative_to(fixtures).as_posix())
    found.sort()
    return found, notes


def fmt_answers(answers):
    lines = []
    for kind in sorted(answers):
        val = answers[kind]
        if kind in ("前导零科目编码行", "斜杠短写日期行"):
            if len(val) > 30:
                lines.append(f"- {kind}：{len(val)} 行（行号略，回读时按科目编码 0101/0102、"
                             f"日期含「/」识别）")
            else:
                lines.append(f"- {kind}：{len(val)} 行（行号 {'、'.join(map(str, val))}）")
        else:
            rows_txt = "、".join(str(i) for i, _ in val)
            extra = "；".join(n for _, n in val if n)
            lines.append(f"- {kind}：{len(val)} 行（行号 {rows_txt}）"
                         + (f"——{extra}" if extra else ""))
    return lines


# ---------------------------------------------------------------------------
# 自检（生成后立即回读核对）
# ---------------------------------------------------------------------------


def parse_delimited_file(path, encoding, delimiter, bom):
    raw = path.read_bytes()
    if encoding == "gbk":
        text = raw.decode("gbk")  # strict：解码失败即抛错
    elif bom:
        text = raw.decode("utf-8-sig")
    else:
        text = raw.decode("utf-8")
    return [r for r in csv.reader(io.StringIO(text), delimiter=delimiter) if r]


def run_selfchecks(expected):
    checks = []

    def add(name, ok, detail=""):
        checks.append((name, bool(ok), detail))

    parsed = {}
    # 1) 三个小文件 + 中规模：编码、BOM、行数、列数
    for key in ("utf8", "gbk", "tsv", "medium"):
        spec = expected[key]
        p = OUT_DIR / spec["name"]
        raw = p.read_bytes()
        if spec.get("bom"):
            add(f"{spec['name']} 带 UTF-8 BOM", raw.startswith(b"\xef\xbb\xbf"))
        else:
            add(f"{spec['name']} 无 BOM", not raw.startswith(b"\xef\xbb\xbf"))
        try:
            rows = parse_delimited_file(p, spec["encoding"], spec["delim"], spec.get("bom", False))
            if spec["encoding"] == "gbk":
                add(f"{spec['name']} 按 gbk 严格解码通过", True, f"{len(raw)} 字节")
            parsed[key] = rows
        except UnicodeDecodeError as e:
            add(f"{spec['name']} 解码", False, str(e))
            parsed[key] = []
            continue
        add(f"{spec['name']} 数据行数与参数一致", len(rows) - 1 == spec["rows"],
            f"实际 {len(rows) - 1} / 期望 {spec['rows']}")
        add(f"{spec['name']} 每行列数恒为 9（分隔符「{spec['delim'] if spec['delim'] != chr(9) else 'Tab'}」）",
            all(len(r) == 9 for r in rows))

    # 2) 流水号列：18 位纯数字、前导零未损（编号大数保护，设计文档第 9 节）
    for key in ("utf8", "gbk", "tsv", "medium"):
        spec = expected[key]
        serials = [r[8] for r in parsed[key][1:] if len(r) == 9 and r[8] != ""]
        ok18 = all(re.fullmatch(r"\d{18}", s) for s in serials)
        lead0 = [s for s in serials if s.startswith("0")]
        add(f"{spec['name']} 流水号全部 18 位纯数字文本", ok18, f"共 {len(serials)} 个")
        add(f"{spec['name']} 前导零流水号保留", len(lead0) == spec["lead_zero"],
            f"实际 {len(lead0)} 个 / 期望 {spec['lead_zero']}")

    # 3) 伪 xls：UTF-8 逗号分隔文本 + .xls 后缀
    p = OUT_DIR / expected["fakexls"]["name"]
    rows = [r for r in csv.reader(io.StringIO(p.read_bytes().decode("utf-8"))) if r]
    add("伪 xls 内容为 UTF-8 逗号分隔文本且每行 9 列", all(len(r) == 9 for r in rows),
        f"数据行 {len(rows) - 1}")
    add("伪 xls 后缀为 .xls（内容识别测试）", p.suffix == ".xls")

    # 4) 映射表：行数、重复键、多余科目、缺失科目
    p = OUT_DIR / expected["mapping"]["name"]
    rows = [r for r in csv.reader(io.StringIO(p.read_bytes().decode("utf-8-sig"))) if r]
    codes = [r[0] for r in rows[1:]]
    add("映射表数据行数与参数一致", len(rows) - 1 == 20, f"实际 {len(rows) - 1} 行")
    add("映射表 6602 出现两次（关联键重复膨胀）", codes.count("6602") == 2)
    add("映射表含明细未用科目 9900（右未匹配）", "9900" in codes)
    add("映射表缺失 6801/1601（左未匹配）", all(c not in codes for c in MAPPING_MISSING))
    add("映射表前导零科目编码 0101 为文本保留", "0101" in codes)

    # 5) xlsx 类型保真（若已生成）
    xp = OUT_DIR / expected["xlsx"]["name"]
    if expected["xlsx"]["name"] and xp.exists():
        from openpyxl import load_workbook
        wb = load_workbook(xp)
        ws = wb.active
        serial_ok, n_serial = True, 0
        code0101 = False
        for row in ws.iter_rows(min_row=2):
            c = row[8]
            if c.value in (None, ""):
                continue
            n_serial += 1
            if not (isinstance(c.value, str) and re.fullmatch(r"\d{18}", c.value)):
                serial_ok = False
            if isinstance(row[3].value, str) and row[3].value == "0101":
                code0101 = True
        add("xlsx 流水号列回读为文本且 18 位完整", serial_ok, f"共 {n_serial} 个")
        add("xlsx 前导零科目编码 0101 未损", code0101)
    else:
        add("xlsx 生成（openpyxl 缺失，已跳过）", False, "详见 README openpyxl 说明")

    # 6) 借贷合计与构造侧一致（纯数字行口径，回读 vs 生成时已知答案）
    for key in ("utf8", "gbk", "tsv", "medium"):
        spec = expected[key]
        got = totals_from_flat(parsed[key][1:])
        exp = spec["totals"]
        add(f"{spec['name']} 纯数字金额合计与构造侧一致", got == exp,
            f"借 {got[0]:,.2f}（{got[2]} 笔）/ 贷 {got[1]:,.2f}（{got[3]} 笔）")

    return all(ok for _, ok, _ in checks), checks


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------


def main():
    global OUT_DIR
    ap = argparse.ArgumentParser(description="生成 DataFlow 合成测试数据（第一阶段小/中规模）")
    ap.add_argument("--small-rows", type=int, default=200, help="三个月度小文件各自的数据行数")
    ap.add_argument("--medium-rows", type=int, default=50000, help="全年中规模文件数据行数")
    ap.add_argument("--fakexls-rows", type=int, default=60)
    ap.add_argument("--xlsx-rows", type=int, default=80)
    ap.add_argument("--seed", type=int, default=20261027)
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    args = ap.parse_args()

    OUT_DIR = Path(args.out)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    answers = {}
    rng = random.Random(args.seed)
    serial = SerialGen()

    f_utf8 = "序时账_2026-01_小_UTF8无BOM_逗号.csv"
    f_gbk = "序时账_2026-02_小_GBK_分号.csv"
    f_tsv = "序时账_2026-03_小_UTF8BOM_Tab.tsv"
    f_med = "序时账_2026全年_中规模_5万行.csv"
    f_fake = "财务系统导出_伪xls.xls"
    f_map = "科目映射表.csv"
    f_xlsx = "序时账_2026-05_小.xlsx"

    # --- 三个小文件：格式差异 + 十二类埋点 ---
    rows1 = build_month_rows(rng, 1, args.small_rows, 0.25, serial, lambda i: f"记-{i:04d}")
    rows2 = build_month_rows(rng, 2, args.small_rows, 0.25, serial, lambda i: f"{i:04d}")
    rows3 = build_month_rows(rng, 3, args.small_rows, 0.30, serial, lambda i: f"记-{i:04d}")

    plan = small_file_plan()
    # GBK 无法编码 U+00A0/U+200B，该文件不可见字符行改用全角空格 U+3000
    plan_gbk = [
        (idx, kind, dict(kw, char="\u3000", desc="全角空格")
         if kind == "不可见字符" and kw.get("char") in ("\u00A0", "\u200B") else kw)
        for idx, kind, kw in plan
    ]
    apply_dirty(rows1, plan, answers, f_utf8)
    apply_dirty(rows2, plan_gbk, answers, f_gbk)
    apply_dirty(rows3, plan, answers, f_tsv)

    write_delimited(OUT_DIR / f_utf8, rows1, "utf-8", ",")
    write_delimited(OUT_DIR / f_gbk, rows2, "gbk", ";")
    write_delimited(OUT_DIR / f_tsv, rows3, "utf-8", "\t", bom=True)

    # --- 全年中规模文件 ---
    med_rows = []
    for m in range(1, 13):
        med_rows.extend(build_month_rows(
            rng, m, args.medium_rows // 12 + 6, 0.25, serial,
            lambda i, m=m: f"记-{m:02d}{i:04d}"))
    med_rows = med_rows[:args.medium_rows]
    apply_dirty(med_rows, medium_file_plan(args.medium_rows), answers, f_med)
    write_delimited(OUT_DIR / f_med, med_rows, "utf-8", ",")

    # --- 伪 xls（财务系统导出兼容样例）---
    fk_rows = build_month_rows(rng, 7, args.fakexls_rows, 0.5, serial,
                               lambda i: f"记-{i:04d}")
    apply_dirty(fk_rows, [
        (40, "千分位", {"side": "借方金额", "value": 1234567.89}),
        (52, "全角括号客商", {}),
    ], answers, f_fake)
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
        xr = build_month_rows(rng, 5, args.xlsx_rows, 0.35, serial, lambda i: f"记-{i:04d}")
        apply_dirty(xr, [
            (30, "千分位", {"side": "借方金额", "value": 1234567.89}),
            (45, "金额带单位", {"side": "贷方金额", "value": 5000}),
            (50, "全角括号客商", {}),
            (55, "首尾空格", {"field": "客商名称"}),
            (60, "客商空值", {}),
            (65, "前导零流水号", {}),
            (70, "全角破折号摘要", {}),
        ], answers, f_xlsx)
        write_xlsx(OUT_DIR / f_xlsx, xr)

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

    all_ok, checks = run_selfchecks(expected)

    # --- README ---
    existing, notes = scan_existing_fixtures()
    today = dt.date.today().isoformat()
    cmd = "python " + " ".join([sys.argv[0].replace("\\", "/")] + sys.argv[1:])
    if len(sys.argv) == 1:
        cmd += "  #（默认参数：小文件各 200 行、中规模 50000 行）"

    small_dirty_desc = ("千分位金额 3、金额带单位 2、全角数字金额 1、全角括号负数 1（两行配对）、"
                        "全角括号客商 3、首尾空格 3、不可见字符 3、金额空值 2、客商空值 1、摘要空值 1、"
                        "纯空格客商 2（半角/全角各 1）、重复凭证号 1、全角破折号摘要 3、整行空记录 2、"
                        "前导零流水号 2、四位小数金额 2；前导零科目编码（0101/0102）与斜杠短写日期"
                        "（2026/1/3）自然散布全文件")

    file_table = [
        (f_utf8, "UTF-8 无 BOM", "逗号", f"{args.small_rows} 行", small_dirty_desc,
         "CSV/文本输入节点：编码与分隔符识别；字段清洗（去千分位、去单位、全半角归一、去不可见字符、去首尾空格）；"
         "公式（文本转十进制）；「预览采样取不到后半段埋错」"),
        (f_gbk, "GBK", "分号", f"{args.small_rows} 行",
         small_dirty_desc.replace("不可见字符 3", "不可见字符 3（因 GBK 无法编码 U+00A0/U+200B，改用全角空格 U+3000）"),
         "编码自动识别（GBK）＋分号分隔识别；其余同上"),
        (f_tsv, "UTF-8 带 BOM", "Tab（.tsv 后缀）", f"{args.small_rows} 行", small_dirty_desc,
         "BOM 处理；tsv 后缀与 Tab 分隔识别；其余同上"),
        (f_med, "UTF-8 无 BOM", "逗号", f"{args.medium_rows} 行",
         "轻量埋点（全部在 60% 行以后）：千分位 20、全角括号客商 5、首尾空格 5、不可见字符 5、"
         "金额空值 10、纯空格客商 5、全角破折号摘要 5、整行空记录 2、前导零流水号 2、四位小数 10、重复凭证号 1",
         "性能 sanity（约 5 万行，对应设计文档 13.3 性能标定的入门档）；预览采样（前 1000 条）看不到埋错，"
         "验证「预览通过不代表全量正确」"),
        (f_fake, "UTF-8 无 BOM", "逗号（后缀 .xls）", f"{args.fakexls_rows} 行",
         "千分位金额 1 行、全角括号客商 1 行",
         "伪 xls 按内容识别、不从后缀推断（设计文档第 9 节「特殊兼容」、第 10 节格式边界表）"),
        (f_map, "UTF-8 带 BOM", "逗号", f"{len(map_rows)} 行",
         "6602 管理费用重复出现两次（费用－办公 / 费用－其他，费用类别不同）；"
         "9900 为明细未用科目；刻意缺失 6801、1601 两个明细在用科目",
         "关联 Join 节点：J 路键重复膨胀（6602 的明细行应×2）、L 路左未匹配（6801/1601 的明细行）、"
         "R 路右未匹配（9900 一行）"),
    ]
    if xlsx_ok:
        file_table.append((f_xlsx, "（xlsx 二进制）", "单 Sheet「序时账」", f"{args.xlsx_rows} 行",
                           "流水号/科目编码/凭证号列文本格式；日期列前 60% 文本（含斜杠短写）、后 40% 真日期单元格；"
                           "千分位文本金额、带单位金额、全角括号客商、首尾空格客商、空客商、前导零流水号、全角破折号摘要",
                           "Excel 输入节点：类型保真（18 位文本流水号不损、前导零科目编码）、"
                           "文本日期与真日期混排的类型判定（设计文档第 9 节「编号与大数保护」「Excel 数字单元格与文本需区分」）"))

    readme = []
    readme.append("# DataFlow 合成测试数据（第一阶段：小/中规模）")
    readme.append("")
    readme.append(f"- 生成日期：{today}；生成命令：`{cmd}`；随机种子：{args.seed}（同参数重跑结果一致）。")
    readme.append("- 本目录全部为脚本合成的虚构数据，不含任何真实业务数据；客商、科目、金额均随机生成。")
    readme.append("- 生成脚本：`scripts/gen_dataflow_fixtures.py`（仅 Python 标准库；xlsx 样例可选依赖 openpyxl）。"
                  "重跑会覆盖本目录同名文件，不改动仓库其他任何文件。")
    readme.append("- 设计依据：`DATAFLOW_DESIGN.md` 第 9 节（数据规则）、第 10 节（输入输出格式边界）；"
                  "`DATAFLOW_ACCEPTANCE_FLOWS.md` 第 2 节（流程一·批量清洗合并的埋错设计）。"
                  "验收文档第 5 节的千万行级规模数据为远期目标，本目录不含。")
    readme.append("- 埋错位置遵循验收文档 1.4 节总原则：小文件脏数据集中在第 110 行以后（文件后半段），"
                  "中规模文件埋在 60% 行以后——预览采样（前 1000 条）取不到。")
    readme.append("")
    readme.append("## 一、文件清单")
    readme.append("")
    readme.append("| 文件 | 编码 | 分隔符 | 数据行数 | 埋入的问题数据 | 测试用途（对应设计文档规则/节点） |")
    readme.append("| --- | --- | --- | --- | --- | --- |")
    for t in file_table:
        readme.append("| " + " | ".join(t) + " |")
    readme.append("")
    readme.append("序时账字段统一为 9 列：凭证日期、凭证号、摘要、科目编码、科目名称、借方金额、贷方金额、客商名称、流水号。"
                  "凭证号在 01/03 号小文件与 xlsx 为「记-0001」样式（可供分列 Split 节点测试），"
                  "02 号小文件为纯数字前导零「0001」样式（编号前导零保留）。"
                  "三种格式属性（UTF-8 无 BOM 逗号 / GBK 分号 / UTF-8 BOM Tab）按任务约定由三个小文件分摊覆盖，"
                  "其中「分号分隔」并入 GBK 文件。")
    readme.append("")
    readme.append("## 二、构造侧已知答案")
    readme.append("")
    readme.append("行号为数据行序号（不含表头）；每行至多埋一类问题数据（全角括号负数的两行配对视为一组）。")
    key_map = {f_utf8: ("utf8", rows1), f_gbk: ("gbk", rows2), f_tsv: ("tsv", rows3)}
    for label, (key, rows_obj) in key_map.items():
        readme.append("")
        readme.append(f"### {label}")
        readme.extend(fmt_answers(answers.get(label, {})))
        t = expected[key]["totals"]
        readme.append(f"- 纯数字金额行合计：借方 {t[0]:,.2f}（{t[2]} 笔）/ 贷方 {t[1]:,.2f}（{t[3]} 笔）。"
                      "千分位、带单位、全角数字、全角括号负数为文本金额，清洗转数后应计入；"
                      "金额空值行与整行空记录行不计入（后者应被「删除整行空记录」动作删除并计入统计）。")
        readme.append(f"- 科目编码不在映射表（Join 左未匹配 L 路）的行数：{l_path_count(rows_obj)}（科目 6801/1601）。")
    readme.append("")
    readme.append(f"### {f_med}")
    for kind in sorted(answers.get(f_med, {})):
        val = answers[f_med][kind]
        readme.append(f"- {kind}：{len(val)} 行")
    t = expected["medium"]["totals"]
    readme.append(f"- 纯数字金额行合计：借方 {t[0]:,.2f}（{t[2]} 笔）/ 贷方 {t[1]:,.2f}（{t[3]} 笔）。")
    readme.append(f"- 科目编码不在映射表（Join 左未匹配 L 路）的行数：{l_path_count(med_rows)}。")
    readme.append("")
    readme.append(f"### {f_map}")
    readme.append(f"- 共 {len(map_rows)} 行：明细在用科目 {len(MAPPING_CODES)} 个；6602 重复 1 次"
                  "（关联后其全部明细行数×2，膨胀测试）；9900 为右路独有（R 路 1 行）；"
                  "缺失 6801/1601（左未匹配 L 路，行数见上文各文件）。")
    readme.append("")
    readme.append("### 借贷平衡口径")
    readme.append("基础数据按凭证生成，每张凭证借贷相等；脏数据只改写金额表现形式（千分位/带单位/全角），"
                  "清洗转数后平衡仍成立。全角括号负数「（1,000.00）」的两行出现在同一凭证的借贷两侧且金额相等，"
                  "无论按「去括号取正」还是「按括号转负」口径清洗，该凭证自身均保持平衡。"
                  "金额空值行与整行空记录行不参与合计。")
    readme.append("")
    readme.append("## 三、既有仓库样例盘点（只读复用，勿改动）")
    readme.append("")
    readme.append("以下为 `tests/fixtures/` 下（不含本目录）既有的表格样例清单，可直接用于 DataFlow 的"
                  "xlsx/xls 读取测试；本脚本未改动其中任何文件。")
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
        line = f"- [{'通过' if ok else '未通过'}] {name}"
        if detail:
            line += f"（{detail}）"
        readme.append(line)
    n_ok = sum(1 for _, ok, _ in checks if ok)
    readme.append("")
    readme.append(f"- 总结：{n_ok}/{len(checks)} 项通过"
                  + ("。" if all_ok else "；存在未通过项，请检查生成环境后再用。"))
    readme.append("")

    (OUT_DIR / "README.md").write_text("\n".join(readme), encoding="utf-8")

    print(f"生成目录：{OUT_DIR}")
    for spec in expected.values():
        if spec.get("name"):
            print(f"  - {spec['name']}")
    if not xlsx_ok:
        print("  -（openpyxl 不可用，xlsx 样例已跳过，见 README 说明）")
    print(f"自检：{n_ok}/{len(checks)} 项通过")
    if not all_ok:
        for name, ok, detail in checks:
            if not ok:
                print(f"  [未通过] {name}（{detail}）")
        sys.exit(1)


if __name__ == "__main__":
    main()
