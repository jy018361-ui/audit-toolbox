# -*- coding: utf-8 -*-
"""字段库覆盖率验证：用 12 种真实形态的列名，检验角色别名库够不够用。"""
import io, re, os

FX = os.path.join("src-tauri", "src", "fx.rs")
s = io.open(FX, encoding="utf-8").read()
seg = s[s.index("fn roles(kind: &str)"):]
seg = seg[:seg.index("\nfn suggest_mappings")]
cut = seg.index("    } else {")


def norm(v):
    return re.sub(r"[ \n\r\t_\-—/（）()]", "", str(v).lower())


def parse(part):
    out = {}
    for role, body in re.findall(r'\(\s*\n\s+"(\w+)",\s*\n\s+vec!\[([^\]]*)\]', part):
        out[role] = [norm(x) for x in re.findall(r'"([^"]+)"', body)]
    return out


JE_V1, TB_V1 = parse(seg[:cut]), parse(seg[cut:])

# ---------- 12 种真实形态的列 → 应映射角色（"-" 表示不该映射） ----------
FORMS = [
 ("TB-A SAP科目明细", "tb", [
   ("科目名称一级", "accountName"), ("科目名称二级", "accountName"), ("科目代码", "accountCode"),
   ("公司代码", "entity"), ("货币", "functionalCurrency"), ("文本", "currencyText"),
   ("费用性质", "-"), ("二级费用科目", "-"),
   ("期初金额-本位币", "openingFunctionalAmount"), ("借方金额-本位币", "periodFunctionalDebit"),
   ("贷方金额-本位币", "periodFunctionalCredit"), ("期末金额-本位币", "closingFunctionalAmount"),
   ("绝对差异-本位币", "-")]),
 ("TB-B SAP报表三合一", "tb", [
   ("Company Code", "entity"), ("GL Account", "accountCode"), ("GL Description", "accountName"),
   ("MTD Local Curr", "periodFunctionalAmount"), ("Currency", "currency"),
   ("YTD Act (Local Curr)", "closingFunctionalAmount")]),
 ("TB-C 用友标准", "tb", [
   ("科目编码", "accountCode"), ("科目名称", "accountName"),
   ("期初余额借方", "openingFunctionalDebit"), ("期初余额贷方", "openingFunctionalCredit"),
   ("本期发生借方", "periodFunctionalDebit"), ("本期发生贷方", "periodFunctionalCredit"),
   ("期末余额借方", "closingFunctionalDebit"), ("期末余额贷方", "closingFunctionalCredit")]),
 ("TB-D 金蝶双层", "tb", [
   ("科目编码", "accountCode"), ("科目名称", "accountName"),
   ("期初余额-借方", "openingFunctionalDebit"), ("期初余额-贷方", "openingFunctionalCredit"),
   ("本期发生-借方", "periodFunctionalDebit"), ("本期发生-贷方", "periodFunctionalCredit"),
   ("本年累计-借方", "ytdFunctionalDebit"), ("本年累计-贷方", "ytdFunctionalCredit"),
   ("期末余额-借方", "closingFunctionalDebit"), ("期末余额-贷方", "closingFunctionalCredit"),
   ("方向", "-")]),
 ("TB-E Oracle全年TB", "tb", [
   ("Account", "accountCode"), ("Account Desc", "accountName"),
   ("SL Account", "accountCode"), ("SL Account Desc", "accountName"),
   ("Begin Balance", "openingFunctionalAmount"), ("Period Dr", "periodFunctionalDebit"),
   ("Period Cr", "periodFunctionalCredit"), ("End Balance", "closingFunctionalAmount"),
   ("SOB Name", "-"), ("Company", "entity")]),
 ("TB-F Oracle分月TBD", "tb", [
   ("Break Segment", "entity"), ("Account", "accountCode"), ("Account Desc", "accountName"),
   ("Accounting Flexfield", "-"), ("Beginning Balance", "openingFunctionalAmount"),
   ("Period Debit", "periodFunctionalDebit"), ("Period Credit", "periodFunctionalCredit"),
   ("Period Activity", "periodFunctionalAmount"), ("Ending Balance", "closingFunctionalAmount")]),
 ("JE SAP FI明细", "je", [
   ("公司代码", "entity"), ("凭证号码", "id"), ("记帐日期", "date"), ("凭证类型", "voucherType"),
   ("会计科目", "accountCode"), ("科目文本", "accountName"), ("借贷", "direction"),
   ("凭证金额", "foreignAmount"), ("凭证货币", "currency"), ("本位币金额", "functionalAmount"),
   ("文本", "summary")]),
 ("JE SAP YTD", "je", [
   ("Document Number", "id"), ("Posting Date", "date"), ("G/L Account", "accountCode"),
   ("Document Currency Key", "currency"), ("Document Currency Value", "foreignAmount"),
   ("Company Code Currency Value", "functionalAmount")]),
 ("JE Oracle集团模板", "je", [
   ("Ledger Name", "-"), ("Currency", "functionalCurrency"), ("GL Date", "date"),
   ("Category", "voucherType"), ("Batch Name", "id"), ("JE Name", "id"),
   ("Account Code", "accountCode"), ("Child Description", "accountName"), ("Entry Item", "summary"),
   ("Debits", "functionalDebit"), ("Credits", "functionalCredit"),
   ("Enter Currency", "currency"), ("Enter Debits", "foreignDebit"), ("Enter Credits", "foreignCredit")]),
 ("JE 用友序时账", "je", [
   ("日期", "date"), ("凭证号数", "id"), ("科目编码", "accountCode"), ("科目名称", "accountName"),
   ("摘要", "summary"), ("币种", "currency"), ("方向", "direction"), ("原币", "foreignAmount"),
   ("金额", "functionalAmount"), ("借正贷负", "functionalAmount")]),
 ("JE 金蝶分列式", "je", [
   ("日期", "date"), ("凭证字", "id"), ("凭证号", "id"), ("摘要", "summary"),
   ("科目编码", "accountCode"), ("科目名称", "accountName"), ("币别", "currency"),
   ("原币金额", "foreignAmount"), ("借方金额", "functionalDebit"), ("贷方金额", "functionalCredit")]),
 ("JE 金蝶合并式", "je", [
   ("日期", "date"), ("凭证字号", "id"), ("分录号", "-"), ("摘要", "summary"),
   ("科目代码", "accountCode"), ("科目名称", "accountName"), ("币别", "currency"),
   ("原币金额", "foreignAmount"), ("借方", "functionalDebit"), ("贷方", "functionalCredit")]),
 ("JE AX/D365", "je", [
   ("凭证类型", "voucherType"), ("文本", "summary"), ("账户", "accountCode"),
   ("借方金额（总和）", "functionalDebit"), ("贷方金额（总和）", "functionalCredit"),
   ("货币代码", "currency"), ("金额（总和）", "functionalAmount"), ("凭证号", "id"),
   ("凭证日期", "date"), ("货币借方金额（总和）", "foreignDebit"),
   ("货币贷方金额（总和）", "foreignCredit")]),
]

# ---------- 字段库 v2：补充别名 ----------
ADD = {
 "tb": {
  "entity": ["company", "break segment", "公司", "主体"],
  "accountCode": ["account", "gl account", "account code", "sl account"],
  "accountName": ["account desc", "account description", "gl description", "sl account desc",
                  "account name", "科目描述"],
  "openingFunctionalAmount": ["begin balance", "beginning balance", "期初金额", "年初金额", "期初余额"],
  "closingFunctionalAmount": ["end balance", "ending balance", "ytd act", "ytd actual",
                              "期末金额", "年末金额", "期末余额"],
  "periodFunctionalDebit": ["period dr", "period debit", "借方金额", "本期借方", "借方发生"],
  "periodFunctionalCredit": ["period cr", "period credit", "贷方金额", "本期贷方", "贷方发生"],
  "periodFunctionalAmount": ["period activity", "mtd", "本期净发生"],
  "ytdFunctionalDebit": ["本年累计借方", "ytd debit", "ytd dr"],
  "ytdFunctionalCredit": ["本年累计贷方", "ytd credit", "ytd cr"],
  "functionalCurrency": ["本位币", "functional currency", "currency", "货币"],
 },
 "je": {
  "id": ["batch name", "je name", "凭证字", "凭证字号", "凭证编号", "voucher no"],
  "date": ["gl date", "posting date", "凭证日期", "记账日期"],
  "voucherType": ["category", "凭证类别"],
  "accountCode": ["account code", "账户", "gl account"],
  "accountName": ["child description", "account desc", "科目描述", "科目全名"],
  "summary": ["entry item", "line description", "文本", "摘要"],
  "currency": ["币别", "货币代码", "enter currency", "currency code", "交易币种"],
  "functionalCurrency": ["ledger currency", "本位币"],
  "functionalDebit": ["debits", "借方", "借方金额"],
  "functionalCredit": ["credits", "贷方", "贷方金额"],
  "functionalAmount": ["金额", "本位币金额", "借正贷负"],
  "direction": ["方向", "借贷方向", "借贷", "dr cr"],
  "foreignDebit": ["enter debits", "货币借方金额", "原币借方"],
  "foreignCredit": ["enter credits", "货币贷方金额", "原币贷方"],
 },
}
# ---------- 字段库 v2：冲突词（防止短别名把别的列吃掉） ----------
CONF = {
 "tb": {
  "functionalCurrency": ["金额", "余额", "balance", "amount", "发生", "差异"],
  "currency": ["金额", "余额", "balance", "amount", "发生", "差异"],
  "accountCode": ["desc", "description", "名称", "文本", "flexfield", "segment"],
  "accountName": ["flexfield", "segment", "code"],
 },
 "je": {
  "accountCode": ["desc", "description", "名称", "文本"],
  "currency": ["金额", "amount", "value"],
  "functionalCurrency": ["金额", "amount", "value"],
 },
}
# 合并后不再使用的角色
DROP = {"je": ["foreignDirection", "functionalDirection"], "tb": []}


def build(base, kind):
    al = {r: list(v) for r, v in base.items() if r not in DROP[kind]}
    for r, extra in ADD.get(kind, {}).items():
        al.setdefault(r, []).extend(norm(x) for x in extra)
    return al


def match(alias, conf, col):
    n = norm(col)
    best = None
    for role, al in alias.items():
        if any(norm(c) in n for c in conf.get(role, [])):
            continue
        for a in al:
            if n == a:
                sc = 2.0
            elif a and a in n:
                sc = 1.0 + len(a) / 100.0
            else:
                continue
            if best is None or sc > best[1]:
                best = (role, sc)
    return best[0] if best else ""


def run(libs, confs, label):
    st = {"OK": 0, "WRONG": 0, "MISS": 0, "NOISE": 0}
    left = []
    for name, kind, cols in FORMS:
        al, cf = libs[kind], confs.get(kind, {})
        for col, want in cols:
            got = match(al, cf, col)
            if want == "-":
                r = "NOISE" if got else "OK"
            elif not got:
                r = "MISS"
            else:
                r = "OK" if got == want else "WRONG"
            st[r] += 1
            if r != "OK":
                left.append("  %-20s %-24s 应=%-26s 实=%s"
                            % (name, col, want, got or "认不出"))
    total = sum(st.values())
    print("%s：正确 %d / %d = %.0f%%   （错 %d，认不出 %d，噪声 %d）"
          % (label, st["OK"], total, st["OK"] * 100.0 / total, st["WRONG"], st["MISS"], st["NOISE"]))
    return left


print()
run({"je": JE_V1, "tb": TB_V1}, {}, "现状（fx.rs 里的别名库）")
left = run({"je": build(JE_V1, "je"), "tb": build(TB_V1, "tb")}, CONF, "字段库 v2")
print("\n剩余 %d 条：" % len(left))
for x in left:
    print(x)
