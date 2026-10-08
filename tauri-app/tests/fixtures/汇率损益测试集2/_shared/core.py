# -*- coding: utf-8 -*-
"""
汇率损益测试集2 共享生成核心：分录引擎 + TB 滚动 + 干净账自检。

十套数据集共用的记账模型。设计目标（干净账口径，全部满足则审计工具测算差异应为 0）：
  1. 所有外币业务按「当月记账汇率」入账，本位币金额 = round(原币 x 当月记账汇率, 2)；
  2. 外币货币性科目（银行/应收/应付/往来/借款）每月末按「月末牌价」全额重估，
     重估后账面本位币余额 == round(期末原币余额 x 月末牌价, 2)；
  3. 已实现汇兑损益 = 实际本位币收付 - 审计滚动基础释放额，与客户入账金额一致：
     - 收回应收/归还应付：整票全额结清，释放基础 = 该票入账汇率折算额；
     - 结汇：外币资金按「滚动本位币余额 / 滚动原币余额」比例释放；
  4. TB 期初 = 期初原币 x 期初牌价（上年末已按牌价重估的延续）。

控制台输出不使用 emoji（Windows GBK 兼容）。
"""
from __future__ import annotations

import os
import sys
from datetime import date

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

EPS = 0.005


def r2(x) -> float:
    return round(float(x) + 0.0, 2)


# ────────────────────────────── 记账主体 ──────────────────────────────

class Book:
    """一个公司账套：科目表、期初、分录、汇率表、滚动余额。"""

    def __init__(self, entity, functional, rates, year=2026, months=(1, 2, 3, 4, 5, 6)):
        # rates: {币种: {"opening": r0, "book": {月: r}, "close": {月: r}}}，不含本位币
        self.entity = entity
        self.functional = functional
        self.rates = rates
        self.year = year
        self.months = list(months)
        self.accounts = {}          # code -> dict(name, parent, drcr, monetary)
        self.opening = {}           # (acct, ccy) -> orig
        self.entries = []           # 已过账分录行（含凭证号）
        self.vno_seq = {}           # vtype -> 已用号数
        self.realized_events = []   # (date, desc, gain_signed)
        self.unreal_events = []     # (date, acct, ccy, adj)
        self._bal = {}              # (acct, ccy) -> [orig, func]

    # ── 汇率 ──
    def opening_rate(self, ccy):
        if ccy == self.functional:
            return 1.0
        return self.rates[ccy]["opening"]

    def book_rate(self, ccy, d: date):
        if ccy == self.functional:
            return 1.0
        return self.rates[ccy]["book"][d.month]

    def close_rate(self, ccy, month):
        if ccy == self.functional:
            return 1.0
        return self.rates[ccy]["close"][month]

    def month_end(self, month) -> date:
        import calendar
        return date(self.year, month, calendar.monthrange(self.year, month)[1])

    def day(self, month, day) -> date:
        import calendar
        day = min(day, calendar.monthrange(self.year, month)[1])
        return date(self.year, month, day)

    # ── 科目与期初 ──
    def add(self, code, name, parent=None, drcr=1, monetary=True):
        self.accounts[code] = {
            "name": name, "parent": parent, "drcr": drcr, "monetary": monetary,
        }

    def set_open(self, acct, ccy, orig):
        self.opening[(acct, ccy)] = r2(orig)
        rate = self.opening_rate(ccy)
        self._bal[(acct, ccy)] = [r2(orig), r2(orig * rate)]

    def bal(self, acct, ccy):
        return tuple(self._bal.get((acct, ccy), (0.0, 0.0)))

    def state_asof(self, d):
        """截至日期 d 的（科目, 币种)->[原币, 本位币] 余额，按日期重放，与过账顺序无关。"""
        state = {}
        for (acct, ccy), orig in self.opening.items():
            state[(acct, ccy)] = [r2(orig), r2(orig * self.opening_rate(ccy))]
        for e in self.entries:
            if e["date"] > d:
                continue
            st = state.setdefault((e["acct"], e["ccy"]), [0.0, 0.0])
            st[0] = r2(st[0] + e["dr_o"] - e["cr_o"])
            st[1] = r2(st[1] + e["dr_f"] - e["cr_f"])
        return state

    def foreign_ccys(self):
        out = set()
        for (_, ccy) in list(self.opening) + [(e["acct"], e["ccy"]) for e in self.entries]:
            if ccy != self.functional:
                out.add(ccy)
        return sorted(out)

    # ── 过账 ──
    def post(self, d, vtype, summary, lines):
        """lines: (acct, ccy, dr_orig, cr_orig, dr_func=None, cr_func=None)
        本位币金额缺省按当月记账汇率折算。返回凭证号（vtype-n）。"""
        self.vno_seq[vtype] = self.vno_seq.get(vtype, 0) + 1
        vno = "%s-%d" % (vtype, self.vno_seq[vtype])
        prepared = []
        for line in lines:
            if len(line) == 4:
                (acct, ccy, dr_o, cr_o, dr_f, cr_f) = tuple(line) + (None, None)
            else:
                (acct, ccy, dr_o, cr_o, dr_f, cr_f) = line
            if ccy != self.functional:
                rate = self.book_rate(ccy, d)
                if dr_f is None:
                    dr_f = r2(dr_o * rate)
                if cr_f is None:
                    cr_f = r2(cr_o * rate)
            else:
                dr_f = dr_o if dr_f is None else dr_f
                cr_f = cr_o if cr_f is None else cr_f
            prepared.append({
                "date": d, "vtype": vtype, "vno": vno, "summary": summary,
                "acct": acct, "name": self.accounts[acct]["name"], "ccy": ccy,
                "dr_o": r2(dr_o), "cr_o": r2(cr_o), "dr_f": r2(dr_f), "cr_f": r2(cr_f),
                "rate": self.book_rate(ccy, d) if ccy != self.functional else None,
            })
            st = self._bal.setdefault((acct, ccy), [0.0, 0.0])
            st[0] = r2(st[0] + dr_o - cr_o)
            st[1] = r2(st[1] + dr_f - cr_f)
        self.entries.extend(prepared)
        return vno

    # ── 业务助手（保证审计口径与客户入账一致） ──
    def invoice(self, d, vtype, summary, ar_acct, rev_acct, ccy, amount):
        """赊销开票：借应收，贷收入（外币）。"""
        return self.post(d, vtype, summary, [
            (ar_acct, ccy, amount, 0.0),
            (rev_acct, ccy, 0.0, amount),
        ])

    def collect_ar(self, d, vtype, summary, ar_acct, bank_acct, ccy, amount, fx_pl):
        """整票收回应收外币货款：借外币银行(当日汇率)，贷应收按截至当日滚动基础比例释放。"""
        day = self.book_rate(ccy, d)
        day_f = r2(amount * day)
        inv_f = self._release_basis(ar_acct, ccy, amount, d)
        gain = r2(day_f - inv_f)
        lines = [(bank_acct, ccy, amount, 0.0, day_f, 0.0),
                 (ar_acct, ccy, 0.0, amount, 0.0, inv_f)]
        if abs(gain) >= EPS:
            if gain > 0:
                lines.append((fx_pl, self.functional, 0.0, gain))
            else:
                lines.append((fx_pl, self.functional, -gain, 0.0))
        self.realized_events.append((d, "收回外币应收 %s %.2f" % (ccy, amount), gain))
        return self.post(d, vtype, summary, lines)

    def pay_ap(self, d, vtype, summary, ap_acct, bank_acct, ccy, amount, fx_pl):
        """整票支付应付外币货款：借应付按截至当日滚动基础比例释放，贷外币银行(当日汇率)。"""
        day = self.book_rate(ccy, d)
        day_f = r2(amount * day)
        inv_f = self._release_basis(ap_acct, ccy, amount, d)
        gain = r2(inv_f - day_f)
        lines = [(ap_acct, ccy, amount, 0.0, inv_f, 0.0),
                 (bank_acct, ccy, 0.0, amount, 0.0, day_f)]
        if abs(gain) >= EPS:
            if gain > 0:
                lines.append((fx_pl, self.functional, 0.0, gain))
            else:
                lines.append((fx_pl, self.functional, -gain, 0.0))
        self.realized_events.append((d, "支付外币应付 %s %.2f" % (ccy, amount), gain))
        return self.post(d, vtype, summary, lines)

    def fx_sell(self, d, vtype, summary, bank_fx, bank_lc, ccy, amount, actual_lc, fx_pl):
        """结汇：外币银行按截至当日滚动基础比例释放，实际本位币入账，差额入汇兑损益。"""
        orig, func = self.state_asof(d).get((bank_fx, ccy), (0.0, 0.0))
        if orig <= 0:
            raise ValueError("结汇时 %s %s 余额不足" % (bank_fx, ccy))
        release = r2(amount * func / orig)
        actual_lc = r2(actual_lc)
        gain = r2(actual_lc - release)
        lines = [(bank_lc, self.functional, actual_lc, 0.0),
                 (bank_fx, ccy, 0.0, amount, 0.0, release)]
        if abs(gain) >= EPS:
            if gain > 0:
                lines.append((fx_pl, self.functional, 0.0, gain))
            else:
                lines.append((fx_pl, self.functional, -gain, 0.0))
        self.realized_events.append((d, "结汇 %s %.2f" % (ccy, amount), gain))
        return self.post(d, vtype, summary, lines)

    def fx_buy(self, d, vtype, summary, bank_fx, bank_lc, ccy, amount):
        """购汇：按当日记账汇率成交，无汇兑损益。"""
        rate = self.book_rate(ccy, d)
        actual = r2(amount * rate)
        return self.post(d, vtype, summary, [
            (bank_fx, ccy, amount, 0.0, actual, 0.0),
            (bank_lc, self.functional, 0.0, actual),
        ])

    def loan_receive(self, d, vtype, summary, loan_acct, bank_acct, ccy, amount):
        rate = self.book_rate(ccy, d)
        amt_f = r2(amount * rate)
        return self.post(d, vtype, summary, [
            (bank_acct, ccy, amount, 0.0, amt_f, 0.0),
            (loan_acct, ccy, 0.0, amount, 0.0, amt_f),
        ])

    def loan_repay(self, d, vtype, summary, loan_acct, bank_acct, ccy, amount, fx_pl):
        day = self.book_rate(ccy, d)
        day_f = r2(amount * day)
        inv_f = self._release_basis(loan_acct, ccy, amount, d)
        gain = r2(inv_f - day_f)
        lines = [(loan_acct, ccy, amount, 0.0, inv_f, 0.0),
                 (bank_acct, ccy, 0.0, amount, 0.0, day_f)]
        if abs(gain) >= EPS:
            if gain > 0:
                lines.append((fx_pl, self.functional, 0.0, gain))
            else:
                lines.append((fx_pl, self.functional, -gain, 0.0))
        self.realized_events.append((d, "归还外币借款 %s %.2f" % (ccy, amount), gain))
        return self.post(d, vtype, summary, lines)


    def _release_basis(self, acct, ccy, amount, d):
        """按截至日期滚动基础（本位币余额/原币余额）比例释放，与审计分配口径一致。"""
        orig, func = self.state_asof(d).get((acct, ccy), (0.0, 0.0))
        if abs(orig) < EPS:
            raise ValueError("释放基础时 %s %s 原币余额为零" % (acct, ccy))
        return r2(abs(amount) * func / orig)

    # ── 月末处理 ──
    def revalue(self, month, fx_pl, vtype="记", summary_fmt="期末外币货币性项目重估"):
        """月末重估：外币货币性科目本位币余额调至 原币x月末牌价（按截至月末的滚动余额）。"""
        d = self.month_end(month)
        state = self.state_asof(d)
        lines = []
        total = 0.0
        for (acct, ccy) in sorted(state):
            if ccy == self.functional:
                continue
            if not self.accounts[acct]["monetary"]:
                continue
            orig, func = state[(acct, ccy)]
            if abs(orig) < EPS:
                continue
            target = r2(orig * self.close_rate(ccy, month))
            adj = r2(target - func)
            if abs(adj) < EPS:
                continue
            # 余额带符号（借正贷负）：调整即拉向目标值，借调增、贷调减
            if adj > 0:
                lines.append((acct, ccy, 0.0, 0.0, adj, 0.0))
            else:
                lines.append((acct, ccy, 0.0, 0.0, 0.0, -adj))
            self.unreal_events.append((d, acct, ccy, adj))
            total = r2(total + adj)
        if not lines:
            return None
        if total >= 0:
            lines.append((fx_pl, self.functional, 0.0, total))
        else:
            lines.append((fx_pl, self.functional, -total, 0.0))
        return self.post(d, vtype, summary_fmt, lines)

    def close_pl(self, month, pl_accts, profit_acct, vtype="记"):
        """期间损益结转：损益类科目各币种键的本月净额（余额带符号）结转本年利润。"""
        d = self.month_end(month)
        lines = []
        for acct in pl_accts:
            for (a, ccy) in sorted(self._bal):
                if a != acct:
                    continue
                total = self._bal[(a, ccy)][1]
                if abs(total) < EPS:
                    continue
                if total > 0:   # 费用类余额在借方：贷方结平，本年利润记借
                    lines.append((acct, ccy, 0.0, 0.0, 0.0, total))
                    lines.append((profit_acct, self.functional, total, 0.0))
                else:           # 收入类余额在贷方：借方结平，本年利润记贷
                    lines.append((acct, ccy, 0.0, 0.0, -total, 0.0))
                    lines.append((profit_acct, self.functional, 0.0, -total))
        if not lines:
            return None
        return self.post(d, vtype, "期间损益结转", lines)

    # ── TB 滚动 ──
    def roll_tb(self):
        """(acct, ccy) -> {open_o, open_f, dr_o, cr_o, dr_f, cr_f, close_o, close_f}"""
        keys = set(self.opening) | {(e["acct"], e["ccy"]) for e in self.entries}
        rows = {}
        for key in sorted(keys):
            acct, ccy = key
            o = self.opening.get(key, 0.0)
            rate0 = self.opening_rate(ccy)
            open_f = r2(o * rate0)
            dr_o = cr_o = dr_f = cr_f = 0.0
            for e in self.entries:
                if e["acct"] == acct and e["ccy"] == ccy:
                    dr_o = r2(dr_o + e["dr_o"]); cr_o = r2(cr_o + e["cr_o"])
                    dr_f = r2(dr_f + e["dr_f"]); cr_f = r2(cr_f + e["cr_f"])
            rows[key] = {
                "acct": acct, "name": self.accounts[acct]["name"], "ccy": ccy,
                "open_o": r2(o), "open_f": open_f,
                "dr_o": dr_o, "cr_o": cr_o, "dr_f": dr_f, "cr_f": cr_f,
                "close_o": r2(o + dr_o - cr_o), "close_f": r2(open_f + dr_f - cr_f),
            }
        return rows


# ────────────────────────────── 统一虚构汇率（对 CNY 报价） ──────────────────────────────

RATES_CNY = {
    "USD": {
        "opening": 7.1030,
        "book":  {1: 7.1050, 2: 7.1180, 3: 7.1420, 4: 7.1290, 5: 7.1550, 6: 7.1680},
        "close": {1: 7.1120, 2: 7.1260, 3: 7.1490, 4: 7.1360, 5: 7.1620, 6: 7.1800},
    },
    "EUR": {
        "opening": 7.8210,
        "book":  {1: 7.8300, 2: 7.8420, 3: 7.8610, 4: 7.8550, 5: 7.8720, 6: 7.8850},
        "close": {1: 7.8380, 2: 7.8510, 3: 7.8690, 4: 7.8620, 5: 7.8800, 6: 7.9000},
    },
    "HKD": {
        "opening": 0.9088,
        "book":  {1: 0.9095, 2: 0.9102, 3: 0.9118, 4: 0.9110, 5: 0.9125, 6: 0.9138},
        "close": {1: 0.9102, 2: 0.9112, 3: 0.9126, 4: 0.9118, 5: 0.9132, 6: 0.9150},
    },
    "JPY": {
        "opening": 0.04795,
        "book":  {1: 0.04805, 2: 0.04820, 3: 0.04855, 4: 0.04840, 5: 0.04875, 6: 0.04890},
        "close": {1: 0.04815, 2: 0.04835, 3: 0.04870, 4: 0.04852, 5: 0.04888, 6: 0.04950},
    },
}

# 外币本位币公司的交叉汇率（虚构，与对 CNY 报价大致相容，具体以各套 README 为准）
RATES_EURUSD = {  # 本位币 USD，EUR 外币
    "EUR": {
        "opening": 1.1010,
        "book":  {1: 1.1020, 2: 1.1040, 3: 1.1060, 4: 1.1050, 5: 1.1080, 6: 1.1090},
        "close": {1: 1.1030, 2: 1.1050, 3: 1.1070, 4: 1.1060, 5: 1.1090, 6: 1.1120},
    },
}
RATES_EURFUNC = {  # 本位币 EUR，USD/CNY 外币
    "USD": {
        "opening": 0.9050,
        "book":  {1: 0.9050, 2: 0.9040, 3: 0.9020, 4: 0.9030, 5: 0.9010, 6: 0.9000},
        "close": {1: 0.9040, 2: 0.9030, 3: 0.9010, 4: 0.9020, 5: 0.9000, 6: 0.8980},
    },
    "CNY": {
        "opening": 0.1275,
        "book":  {1: 0.1276, 2: 0.1277, 3: 0.1274, 4: 0.1275, 5: 0.1272, 6: 0.1271},
        "close": {1: 0.1275, 2: 0.1276, 3: 0.1273, 4: 0.1274, 5: 0.1271, 6: 0.1266},
    },
}
RATES_HKDFUNC = {  # 本位币 HKD，USD/CNY 外币
    "USD": {
        "opening": 7.8020,
        "book":  {1: 7.8050, 2: 7.8100, 3: 7.8150, 4: 7.8120, 5: 7.8200, 6: 7.8240},
        "close": {1: 7.8080, 2: 7.8130, 3: 7.8180, 4: 7.8150, 5: 7.8230, 6: 7.8260},
    },
    "CNY": {
        "opening": 1.0980,
        "book":  {1: 1.0985, 2: 1.0990, 3: 1.0995, 4: 1.0992, 5: 1.1000, 6: 1.1005},
        "close": {1: 1.0988, 2: 1.0993, 3: 1.0998, 4: 1.0995, 5: 1.1003, 6: 1.1008},
    },
}


# ────────────────────────────── 自检 ──────────────────────────────

class Checker:
    def __init__(self):
        self.results = []

    def check(self, name, ok, detail=""):
        self.results.append((bool(ok), name, detail))
        print("[%s] %s%s" % ("通过" if ok else "失败", name, (" -- " + detail) if detail else ""))

    def finish(self):
        fails = [r for r in self.results if not r[0]]
        print("自检完成：%d 项，通过 %d，失败 %d" % (len(self.results), len(self.results) - len(fails), len(fails)))
        if fails:
            sys.exit(1)


def find_header_row(ws, required, limit=12):
    """返回首个满足全部关键词的行号（1-based）；支持两行复合表头（上行组名+下行子列名拼接）。"""
    def norm(s):
        return "".join(str(s).lower().split())

    keys = [norm(k) for k in required]
    for r in range(1, min(ws.max_row, limit) + 1):
        cells = [norm(c.value) for c in ws[r] if c.value is not None]
        if not cells or len(cells) == 1:
            continue  # 单格合并行是标题/信息行，不能作表头
        filled, last = [], ""
        for c in ws[r]:
            v = norm(c.value) if c.value is not None else ""
            if v:
                last = v
            filled.append(last)
        merged = []
        for i in range(len(filled)):
            below = ws.cell(row=r + 1, column=i + 1).value
            if below is not None and r < ws.max_row and filled[i]:
                merged.append(filled[i] + norm(below))
        ok = all(any(k in c for c in cells) or any(k in m for m in merged) for k in keys)
        if ok:
            return r
    return None


def run_clean_checks(ck: Checker, book: Book, tb_rows: dict, fx_pl: str):
    """模型层干净账校验（在内存中独立重放，不依赖写出的文件）。"""
    # 1) 每月末外币货币性科目：账面本位币 == 原币 x 月末牌价
    bad = []
    for month in book.months:
        state = book.state_asof(book.month_end(month))
        for (acct, ccy), (orig, func) in state.items():
            if ccy == book.functional or not book.accounts[acct]["monetary"]:
                continue
            if abs(orig) < EPS:
                continue
            target = r2(orig * book.close_rate(ccy, month))
            if abs(func - target) >= EPS:
                bad.append("%d月 %s %s 账面%.2f != 重估目标%.2f" % (month, acct, ccy, func, target))
    ck.check("月末外币货币性科目全部按月末牌价重估（未实现差异=0）", not bad, "; ".join(bad[:3]))

    # 1b) 原币余额归零的外币科目不得残留本位币余额（重估/结清干净）
    residue = ["%s %s 残留本位币 %.2f" % (row["acct"], row["ccy"], row["close_f"])
               for row in tb_rows.values()
               if row["ccy"] != book.functional and abs(row["close_o"]) < EPS and abs(row["close_f"]) >= EPS]
    ck.check("原币余额为零的外币科目无本位币残留", not residue, "; ".join(residue[:3]))

    # 2) 已实现事件合计 + 未实现重估合计 == 汇兑损益科目 JE 净发生额
    realized_total = r2(sum(g for (_, _, g) in book.realized_events))
    unreal_total = r2(sum(adj for (_, _, _, adj) in book.unreal_events))
    pl_net = _fx_pl_net(book, fx_pl)
    ck.check("账面汇兑损益 = 已实现 + 未实现（%.2f = %.2f + %.2f）" % (pl_net, realized_total, unreal_total),
             abs(r2(realized_total + unreal_total) - pl_net) < EPS
             and abs(realized_total - _realized_posted(book, fx_pl)) < EPS,
             "已实现入账 %.2f" % _realized_posted(book, fx_pl))

    # 3) 非平凡性：至少 2 笔已实现、至少 3 个月有重估调整、每个外币期末有货币性余额
    ck.check("已实现事件不少于 2 笔（当前 %d）" % len(book.realized_events), len(book.realized_events) >= 2)
    months_with_adj = len({d.month for (d, _, _, _) in book.unreal_events})
    ck.check("有重估调整的月份不少于 3 个（当前 %d）" % months_with_adj, months_with_adj >= 3)
    closing_ccys = {ccy for (acct, ccy), row in tb_rows.items()
                    if ccy != book.functional and book.accounts[acct]["monetary"] and abs(row["close_o"]) >= EPS}
    ck.check("每个外币币种期末均有货币性余额（%s）" % ",".join(sorted(closing_ccys)),
             closing_ccys == set(book.foreign_ccys()))

    # 4) 每张凭证本位币借贷平衡；单一币种凭证原币平衡
    vouchers = {}
    for e in book.entries:
        vouchers.setdefault(e["vno"], []).append(e)
    bad = []
    for vno, lines in vouchers.items():
        dr = r2(sum(l["dr_f"] for l in lines)); cr = r2(sum(l["cr_f"] for l in lines))
        if abs(dr - cr) >= EPS:
            bad.append("%s 本位币借%.2f贷%.2f" % (vno, dr, cr))
        ccys = {l["ccy"] for l in lines}
        if len(ccys) == 1 and ccys != {book.functional}:
            dr_o = r2(sum(l["dr_o"] for l in lines)); cr_o = r2(sum(l["cr_o"] for l in lines))
            if abs(dr_o - cr_o) >= EPS:
                bad.append("%s 原币借%.2f贷%.2f" % (vno, dr_o, cr_o))
    ck.check("每张凭证本位币平衡且单币种凭证原币平衡（%d 张）" % len(vouchers), not bad, "; ".join(bad[:3]))

    # 5) TB 滚动恒等式与试算平衡（余额带符号，借正贷负，合计应为 0）
    bad = []
    for key, row in tb_rows.items():
        if abs(r2(row["open_o"] + row["dr_o"] - row["cr_o"]) - row["close_o"]) >= EPS or \
           abs(r2(row["open_f"] + row["dr_f"] - row["cr_f"]) - row["close_f"]) >= EPS:
            bad.append(str(key))
    ck.check("TB 逐行满足 期初+借-贷=期末（原币/本位币）", not bad, "; ".join(bad[:3]))
    open_net = r2(sum(row["open_f"] for row in tb_rows.values()))
    close_net = r2(sum(row["close_f"] for row in tb_rows.values()))
    ck.check("TB 期初/期末本位币试算平衡（%0.2f / %0.2f）" % (open_net, close_net),
             abs(open_net) < EPS and abs(close_net) < EPS)

    # 6) 规模
    ck.check("凭证数量在标准集区间（%d）" % len(vouchers), 105 <= len(vouchers) <= 165)
    ck.check("JE 行数在标准集区间（%d）" % len(book.entries), 230 <= len(book.entries) <= 360)
    ck.check("TB 行数在合理区间（%d）" % len(tb_rows), 22 <= len(tb_rows) <= 90)


def _realized_posted(book, fx_pl):
    """结算/结汇凭证（外币原币有实际借贷）中的汇兑损益行净额 = 已实现入账合计。"""
    total = 0.0
    for vno in {e["vno"] for e in book.entries}:
        lines = [e for e in book.entries if e["vno"] == vno]
        has_fx_flow = any(l["ccy"] != book.functional and
                          (abs(l["dr_o"]) >= EPS or abs(l["cr_o"]) >= EPS) for l in lines)
        pl = [l for l in lines if l["acct"] == fx_pl]
        if pl and has_fx_flow:
            total = r2(total + sum(l["cr_f"] - l["dr_f"] for l in pl))
    return total


def _fx_pl_net(book, fx_pl):
    """汇兑损益科目 JE 净发生额（贷方正数，含结转冲销后的净额）。"""
    return r2(sum(e["cr_f"] - e["dr_f"] for e in book.entries if e["acct"] == fx_pl))


def run_file_checks(ck: Checker, book: Book, exp: dict, tb_rows: dict):
    """文件层校验：表头可定位、类型正确、行数/金额合计与模型一致。"""
    from openpyxl import load_workbook

    tb = load_workbook(exp["tb_path"], data_only=True)
    je = load_workbook(exp["je_path"], data_only=True)
    tb_ws, je_ws = tb.active, je.active

    tb_hrow = find_header_row(tb_ws, exp["tb_header_keys"])
    je_hrow = find_header_row(je_ws, exp["je_header_keys"])
    ck.check("TB 表头行可定位（第 %s 行）" % tb_hrow, tb_hrow is not None)
    ck.check("JE 表头行可定位（第 %s 行）" % je_hrow, je_hrow is not None)
    if not tb_hrow or not je_hrow:
        ck.finish()

    def header_map(ws, hrow):
        m = {}
        last = ""
        for c in ws[hrow]:
            name = str(c.value).strip() if c.value is not None else ""
            if name:
                m[name] = c.column
                last = name
            if hrow < ws.max_row:
                below = ws.cell(row=hrow + 1, column=c.column).value
                if below is not None and last:
                    m.setdefault(last + str(below).strip(), c.column)
        return m

    tb_h, je_h = header_map(tb_ws, tb_hrow), header_map(je_ws, je_hrow)

    for h in exp["tb_amount_headers"]:
        ck.check("TB 含金额列「%s」" % h, any(h in k for k in tb_h))
    for h in exp["je_amount_headers"]:
        ck.check("JE 含金额列「%s」" % h, any(h in k for k in je_h))

    date_col = next((c for k, c in je_h.items() if exp["date_header"] in k), None)
    ck.check("JE 含日期列「%s」" % exp["date_header"], date_col is not None)
    if date_col:
        bad = sum(1 for r in range(je_hrow + 1, je_ws.max_row + 1)
                  if (v := je_ws.cell(row=r, column=date_col).value) is not None and not hasattr(v, "year"))
        ck.check("JE 日期列全部为日期型", bad == 0, "异常 %d 行" % bad)

    amt_cols = {c for k, c in je_h.items()
                if any(t in k for t in ("金额", "借方", "贷方", "原币", "本位币", "Amount", "Debit", "Credit"))
                and "方向" not in k}
    amt_bad = 0
    for c in amt_cols:
        for r in range(je_hrow + 1, je_ws.max_row + 1):
            v = je_ws.cell(row=r, column=c).value
            if v is not None and not isinstance(v, (int, float)):
                amt_bad += 1
    ck.check("JE 金额列全部为数值型", amt_bad == 0, "异常 %d 格" % amt_bad)

    ccy_col = next((c for k, c in je_h.items() if "币种" in k or "币别" in k or "Currency" in k), None)
    if ccy_col and exp.get("ccy_values") is not None:
        vals = {str(je_ws.cell(row=r, column=ccy_col).value).strip()
                for r in range(je_hrow + 1, je_ws.max_row + 1)
                if je_ws.cell(row=r, column=ccy_col).value is not None}
        bad = vals - set(exp["ccy_values"])
        ck.check("JE 币种取值合法（%s）" % ",".join(sorted(vals)), not bad, "非法值: %s" % sorted(bad))

    # 行数一致
    tb_file_rows = sum(1 for r in range(tb_hrow + 1, tb_ws.max_row + 1)
                       if any(tb_ws.cell(row=r, column=c).value is not None for c in range(1, 4)))
    ck.check("TB 文件行数与模型一致（%d）" % len(tb_rows), tb_file_rows == len(tb_rows),
             "文件 %d 行 vs 模型 %d 行" % (tb_file_rows, len(tb_rows)))
    je_file_rows = je_ws.max_row - je_hrow
    ck.check("JE 文件行数与模型一致（%d）" % len(book.entries), je_file_rows == len(book.entries),
             "文件 %d 行 vs 模型 %d 行" % (je_file_rows, len(book.entries)))

    # JE 本位币金额合计与模型一致
    for (key, kind) in exp.get("func_check_cols", []):
        col = next((c for k, c in je_h.items() if key in k), None)
        if col is None:
            ck.check("JE 金额列「%s」存在" % key, False)
            continue
        file_sum = r2(sum(v for r in range(je_hrow + 1, je_ws.max_row + 1)
                          if isinstance((v := je_ws.cell(row=r, column=col).value), (int, float))))
        if kind == "dr":
            model_sum = r2(sum(e["dr_f"] for e in book.entries))
        elif kind == "cr":
            model_sum = r2(sum(e["cr_f"] for e in book.entries))
        else:
            model_sum = r2(sum(abs(round(e["dr_f"] - e["cr_f"], 2)) for e in book.entries))
        ck.check("JE「%s」合计与模型一致（%.2f）" % (key, model_sum), abs(file_sum - model_sum) < EPS,
                 "文件 %.2f" % file_sum)

    # TB 试算平衡（按形态）
    mode = exp.get("tb_net_mode", "signed")
    if mode == "signed":
        col = next((c for k, c in tb_h.items()
                    if ("期末" in k or "End" in k) and ("本位币" in k or "Accounted" in k or "Local" in k)), None)
        if col:
            net = r2(sum(v for r in range(tb_hrow + 1, tb_ws.max_row + 1)
                         if isinstance((v := tb_ws.cell(row=r, column=col).value), (int, float))))
            ck.check("TB 期末本位币净额合计为零（%.2f）" % net, abs(net) < EPS)
    elif mode == "split":
        dr_col = next((c for k, c in tb_h.items() if "期末借方" in k and "本位币" in k), None)
        cr_col = next((c for k, c in tb_h.items() if "期末贷方" in k and "本位币" in k), None)
        if dr_col and cr_col:
            def colsum(col):
                return r2(sum(v for r in range(tb_hrow + 1, tb_ws.max_row + 1)
                              if isinstance((v := tb_ws.cell(row=r, column=col).value), (int, float))))
            ck.check("TB 期末借/贷方(本位币)合计轧平", abs(colsum(dr_col) - colsum(cr_col)) < EPS,
                     "借方 %.2f vs 贷方 %.2f" % (colsum(dr_col), colsum(cr_col)))
    else:
        dcol = next((c for k, c in tb_h.items() if "方向" in k), None)
        if dcol:
            vals = {str(tb_ws.cell(row=r, column=dcol).value) for r in range(tb_hrow + 1, tb_ws.max_row + 1)
                    if tb_ws.cell(row=r, column=dcol).value is not None}
            ck.check("TB 方向列取值合法（%s）" % ",".join(sorted(vals)), vals <= {"借", "贷", "平"})


def write_meta(path, title_lines):
    """可选：无操作占位（各渲染器自管标题）。"""
    return path


def run_all(book: Book, exp: dict, fx_pl: str, pl_accts, profit_acct):
    """生成后统一收尾：打印摘要 + 模型层干净账自检 + 文件层自检。"""
    tb_rows = book.roll_tb()
    vouchers = sorted({e["vno"] for e in book.entries})
    realized = r2(sum(g for (_, _, g) in book.realized_events))
    unreal = r2(sum(adj for (_, _, _, adj) in book.unreal_events))
    print("=" * 72)
    print("主体: %s    本位币: %s    外币: %s" % (book.entity, book.functional, ",".join(book.foreign_ccys())))
    print("凭证 %d 张 / 分录 %d 行 / TB %d 行" % (len(vouchers), len(book.entries), len(tb_rows)))
    print("客户账面汇兑损益净额: %.2f（已实现 %.2f + 未实现 %.2f）" % (r2(realized + unreal), realized, unreal))
    print("=" * 72)
    ck = Checker()
    run_clean_checks(ck, book, tb_rows, fx_pl)
    run_file_checks(ck, book, exp, tb_rows)
    ck.finish()
