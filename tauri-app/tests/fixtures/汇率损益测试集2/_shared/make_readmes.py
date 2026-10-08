# -*- coding: utf-8 -*-
"""
汇率损益测试集2 README 生成器：从各套 generate.py 的模型直接取数生成 README.md，
保证文档中的凭证数/行数/汇兑损益金额与数据一致。运行: python make_readmes.py
"""
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

sys.path.insert(0, HERE)

from core import r2  # noqa: E402

SETS = [
    ("01_用友U8_晟微电子", "用友U8", "晟微电子（苏州）有限公司"),
    ("02_用友NC_桦霖化工", "用友NC", "桦霖化工（宁波）有限公司"),
    ("03_金蝶K3_迅骐汽配", "金蝶K/3", "迅骐汽车零部件（台州）有限公司"),
    ("04_金蝶KIS_汇隆贸易", "金蝶KIS专业版", "汇隆进出口贸易有限公司"),
    ("05_SAP_MeritronUSA", "SAP S/4", "Meritron USA Inc."),
    ("06_Oracle_Lindenwerk", "Oracle EBS", "Lindenwerk GmbH"),
    ("07_金蝶云星空_港联香港", "金蝶云星空", "港联供应链（香港）有限公司"),
    ("08_浪潮GS_津港物流", "浪潮GS", "津港国际物流有限公司"),
    ("09_鼎捷E10_台崧电子", "鼎捷E10", "台崧精密电子（东莞）有限公司"),
    ("10_新中大_远洲工程", "新中大", "远洲海外工程有限公司"),
]

FEATURES = {
    "01_用友U8_晟微电子": (
        "电子制造出口商。美元出口（双客户）、欧元出口、国内销售（13%增值税）、"
        "进口美元原材料、欧元五轴设备进口（次月付清）、美元股东借款（收/利息/部分还本）、"
        "隔月结汇。序时账含汇率列与科目余额列，币种列为中文（人民币/美元/欧元）。",
        "TB 表头第 3 行：科目编码/科目名称/币种/期初余额(原币)/期初余额(本位币)/本期发生借方(原币)/"
        "本期发生贷方(原币)/本期发生借方(本位币)/本期发生贷方(本位币)/期末余额(原币)/期末余额(本位币)/方向。"
        "余额列正数+方向列（借/贷/平）。JE 表头第 3 行：日期/凭证字号(记-0001 式)/摘要/科目编码/科目名称/"
        "币种/汇率/借方原币/贷方原币/借方本位币/贷方本位币/余额方向/余额。"),
    "02_用友NC_桦霖化工": (
        "化工集团子公司。美元出口与大宗原料进口、日元备件采购（含 4 月日元检修备件入库、非货币性）、"
        "港币海运费计提与支付、关联方美元往来拆出与全额收回、购汇与隔月结汇。"
        "TB/JE 均带辅助核算列（客商名称）；JE 含记账日期+业务日期双列、凭证号为 4 位数字。",
        "TB 表头第 3 行：年度/会计期间/科目编码/科目名称/辅助核算/币种/期初余额(原币)/期初余额(本位币)/"
        "本年累计借方(原币)/本年累计贷方(原币)/本年累计借方(本位币)/本年累计贷方(本位币)/期末余额(原币)/"
        "期末余额(本位币)；余额为借正贷负带符号净额。JE 表头第 3 行：记账日期/业务日期/凭证类别/凭证号/"
        "摘要/科目编码/科目名称/辅助核算/币种/借方原币/贷方原币/借方本位币/贷方本位币。"),
    "03_金蝶K3_迅骐汽配": (
        "汽配出口制造。美元出口、国内主机厂销售（含应收票据收付）、日元数控磨床进口分两期付汇、"
        "购汇补日元头寸、隔月结汇。TB 为两行复合表头（第 3-4 行），币种列为中文（人民币/美元/日元），"
        "凭证字恒为「记」、凭证号为数字。",
        "TB 第 3 行组名（科目编码/科目名称/币种竖向合并，期初余额、本期发生、期末余额横向合并），"
        "第 4 行子列（原币金额/本位币金额、借方原币金额/贷方原币金额等）。"
        "JE 表头第 3 行：日期/凭证字/凭证号/摘要/科目编码/科目名称/币种/借方(原币)/贷方(原币)/"
        "借方(本位币)/贷方(本位币)/余额(原币)/余额(本位币)（余额借正贷负，辅助列）。"),
    "04_金蝶KIS_汇隆贸易": (
        "小微进出口贸易商。美元出口、港币供应商采购、信用证保证金存退、隔月结汇、展会与审计费等。"
        "本位币金额列在原币列之前（借贷金额(本位币)+借方原币/贷方原币）。",
        "TB 表头第 3 行：科目编码/科目名称/币种/期初余额(原币)/期初余额(本位币)/借方原币金额/"
        "贷方原币金额/借方本位币金额/贷方本位币金额/期末余额(原币)/期末余额(本位币)/方向。"
        "JE 表头第 3 行：日期/凭证字/凭证号(记-001 式)/摘要/科目编码/科目名称/币种/汇率/"
        "借方金额(本位币)/贷方金额(本位币)/借方原币/贷方原币。"),
    "05_SAP_MeritronUSA": (
        "美国销售子公司（集团海外平台），本位币 USD，外币 EUR。欧元区客户销售与回款、本土销售、"
        "母公司美元关联采购、预付保险摊销、员工备用金、欧元→美元结汇、美元购汇补欧元头寸。"
        "英文表头（FBL3N/FAGLLB03 风格），JE 币种列只标外币（USD 行留空），Dr/Cr 取值 S/H，"
        "Posting Date 为 DD.MM.YYYY。期末重估凭证形态为 FAGL_FCV（原币 0、仅调本位币）。",
        "TB 表头第 3 行：Company Code/G/L Account/Account Name/Currency/Period/Opening Balance (Doc. Curr.) "
        "期初原币余额/Debit (Doc. Curr.) 原币借方发生额/Credit (Doc. Curr.) 原币贷方发生额/Balance (Doc. Curr.) "
        "期末原币余额/Opening Balance (Local Curr.) 期初本位币余额/Debit (Local Curr.) 本年累计借方发生额/"
        "Credit (Local Curr.) 本年累计贷方发生额/Balance (Local Curr.) 期末本位币余额（净额带符号）。"
        "JE 表头第 3 行：Company Code/Document No./Document Type/Posting Date/Period/Reference/Text/Currency/"
        "Amount in Doc. Curr. 原币金额/Dr/Cr/Amount in Local Curr. 本位币金额/User Name。"),
    "06_Oracle_Lindenwerk": (
        "德国制造子公司，本位币 EUR，外币 USD/CNY。美元区客户销售与回款、美国芯片采购、"
        "母公司人民币资金支持（1 月收到 50 万、6 月全额归还）、美元→欧元结汇。"
        "英文表头（GL Journals/Trial Balance），Entered/Accounted 双口径，Effective Date 为 "
        "dd-mmm-yyyy，JE Batch/JE Name/Document No 分层编号。",
        "TB 表头第 3 行：Company/Account/Account Name/Currency/Begin Balance (Entered)/Begin Balance "
        "(Accounted)/Period Net Dr (Entered)/Period Net Cr (Entered)/Period Net Dr (Accounted)/Period Net Cr "
        "(Accounted)/End Balance (Entered)/End Balance (Accounted)（净额带符号）。"
        "JE 表头第 3 行：JE Batch/JE Name/Document No/Effective Date/Period/Category/Account/Account Name/"
        "Currency/Entered Dr/Entered Cr/Accounted Dr/Accounted Cr。"),
    "07_金蝶云星空_港联香港": (
        "香港贸易物流公司，本位币 HKD，外币 USD/CNY。美元航线应收（次月收）、内地供应商人民币采购、"
        "内地客户人民币直接收款、美元资本投入（外币投入资本同汇率入账）、美元→港币结汇、季度利得税预提。"
        "币种列名为「币别」；JE 为净额+借贷方向形态（原币金额/本位币金额 + 借贷方向列）。",
        "TB 表头第 3 行：科目编码/科目名称/核算维度/币别/期初余额(原币)/期初余额(本位币)/借方原币金额/"
        "贷方原币金额/借方本位币金额/贷方本位币金额/期末余额(原币)/期末余额(本位币)/期末方向。"
        "JE 表头第 3 行：日期/凭证字号/摘要/科目编码/科目名称/核算维度/币别/汇率/借贷方向/原币金额/本位币金额"
        "（金额一律正数，方向另列；本位币行原币金额留空）。"),
    "08_浪潮GS_津港物流": (
        "国际货代公司。美元海运费应收、港币码头费与日元日本段费用应付（均次月整票付）、"
        "代垫关税收回、购汇补日元头寸、隔月结汇。序时账币种列为「只标外币」形态：人民币行留空、"
        "外币行填 USD/HKD/JPY；TB 币种列逐行全填。",
        "TB 表头第 3 行：科目代码/科目名称/币种/期初余额(原币)/期初余额(本位币)/借方发生额(原币)/"
        "贷方发生额(原币)/借方发生额(本位币)/贷方发生额(本位币)/期末余额(原币)/期末余额(本位币)/期末方向。"
        "JE 表头第 3 行：凭证日期/凭证号(记0001 式)/凭证类型/摘要/科目代码/科目名称/币种/汇率/"
        "借方原币金额/贷方原币金额/借方本位币金额/贷方本位币金额。"),
    "09_鼎捷E10_台崧电子": (
        "台资电子制造。美元出口、欧元 SMT 设备进口（次月付清，非货币性）、关联方美元往来拆出与全额收回、"
        "购汇与隔月结汇。凭证编号为日期前缀式（GL-202601-0001）。",
        "TB 表头第 3 行：科目编号/科目名称/币种/期初余额(原币)/期初余额(本位币)/借方原币金额/"
        "贷方原币金额/借方本位币金额/贷方本位币金额/期末余额(原币)/期末余额(本位币)/余额方向。"
        "JE 表头第 3 行：记账日期/凭证编号/凭证种类/摘要/科目编号/科目名称/币种/汇率/借方原币金额/"
        "贷方原币金额/借方本位币金额/贷方本位币金额。"),
    "10_新中大_远洲工程": (
        "海外工程承包商。美元工程进度款应收（隔月整笔收）、美元项目保证金（其他应收款，3 月部分退还）、"
        "欧洲分包欧元应付（隔月整笔付）、购汇补欧元头寸、隔月结汇、施工设备折旧与工程物资采购。"
        "TB 余额为期初/期末借贷分列式（四组余额列）。",
        "TB 表头第 3 行：科目代码/科目名称/币种/期初借方(原币)/期初贷方(原币)/期初借方(本位币)/"
        "期初贷方(本位币)/借方发生额(原币)/贷方发生额(原币)/借方发生额(本位币)/贷方发生额(本位币)/"
        "期末借方(原币)/期末贷方(原币)/期末借方(本位币)/期末贷方(本位币)。"
        "JE 表头第 3 行：日期/凭证号/摘要/科目代码/科目名称/币种/汇率/借方原币金额/贷方原币金额/"
        "借方本位币金额/贷方本位币金额。"),
}

FILES = {
    "01_用友U8_晟微电子": ("用友U8_科目余额表.xlsx", "用友U8_序时账.xlsx"),
    "02_用友NC_桦霖化工": ("用友NC_科目余额表.xlsx", "用友NC_凭证明细.xlsx"),
    "03_金蝶K3_迅骐汽配": ("金蝶K3_科目余额表.xlsx", "金蝶K3_序时账.xlsx"),
    "04_金蝶KIS_汇隆贸易": ("金蝶KIS_科目余额表.xlsx", "金蝶KIS_账簿明细.xlsx"),
    "05_SAP_MeritronUSA": ("SAP_科目余额表.xlsx", "SAP_凭证明细.xlsx"),
    "06_Oracle_Lindenwerk": ("Oracle_科目余额表.xlsx", "Oracle_总账凭证明细.xlsx"),
    "07_金蝶云星空_港联香港": ("金蝶云星空_科目余额表.xlsx", "金蝶云星空_凭证明细.xlsx"),
    "08_浪潮GS_津港物流": ("浪潮GS_科目余额表.xlsx", "浪潮GS_序时账.xlsx"),
    "09_鼎捷E10_台崧电子": ("鼎捷E10_科目余额表.xlsx", "鼎捷E10_会计凭证明细.xlsx"),
    "10_新中大_远洲工程": ("新中大_科目余额表.xlsx", "新中大_记账凭证序时账.xlsx"),
}


def load_book(folder):
    spec = importlib.util.spec_from_file_location("gen_%s" % folder[:2], os.path.join(ROOT, folder, "generate.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.build()


def rate_table(book):
    lines = ["| 币种 | 期初牌价 | 1-6月记账汇率（逐月） | 1-6月月末牌价（逐月） |",
             "| --- | --- | --- | --- |"]
    for ccy, spec in book.rates.items():
        book_s = " / ".join("%.5g" % spec["book"][m] for m in range(1, 7))
        close_s = " / ".join("%.5g" % spec["close"][m] for m in range(1, 7))
        lines.append("| %s | %g | %s | %s |" % (ccy, spec["opening"], book_s, close_s))
    return "\n".join(lines)


def readme(folder, erp, entity):
    book = load_book(folder)
    tb_rows = book.roll_tb()
    vouchers = sorted({e["vno"] for e in book.entries})
    realized = r2(sum(g for (_, _, g) in book.realized_events))
    unreal = r2(sum(adj for (_, _, _, adj) in book.unreal_events))
    net = r2(realized + unreal)
    tb_file, je_file = FILES[folder]
    feature, mapping = FEATURES[folder]
    pl_account = {e["acct"] for e in book.entries if "汇兑" in e["name"] or "FX" in e["name"]}
    pl_name = book.entries and next(e for e in book.entries if e["acct"] in pl_account)["name"] if pl_account else "汇兑损益"
    foreign = "、".join(book.foreign_ccys())

    tpl = """# 汇率损益测试集2 之 {folder}（{erp} 版式，干净账）

审计工具箱「汇率损益测试」测试数据集。本套为**干净账**：外币货币性项目每月末按月末牌价
全额重估、已实现汇兑损益完整入账，预期工具测算差异为 **0**（审计测算合计应等于客户账面
汇兑损益净额）。

## 一、场景说明

- 虚构主体：{entity}；记账本位币 **{functional}**；外币：{foreign}；期间 2026-01-01 至 2026-06-30。
- 业务画像：{feature}

## 二、汇率表（虚构，测试集统一设定）

{rates}

折算规则：本位币金额 = round(原币金额 x 当月记账汇率, 2)；月末重估后本位币余额 =
round(期末原币余额 x 当月月末牌价, 2)。

## 三、文件清单与规模

| 文件 | 内容 | 规模 |
| --- | --- | --- |
| `{tb_file}` | 科目余额表（TB，科目 x 币种一行） | {tb_rows} 行 |
| `{je_file}` | 凭证明细（JE） | {je_lines} 行 / {vouchers} 张凭证 |
| `generate.py` | 生成 + 自检一体脚本（`python generate.py` 重生成并跑 27 项自检） | — |

客户账面汇兑损益净额：**{net:,.2f} {functional}**（已实现 {realized:,.2f} + 未实现重估 {unreal:,.2f}），
全部计入 {pl_name}。该净额即工具测算结果的期望值。

## 四、干净账验收预期

在审计工具箱「汇率损益测试」中：上传 TB 与 JE → 列映射按第五节自动识别（无需人工调整）→
报告期 2026-01-01 至 2026-06-30 → 汇率面板**改用手动录入**（期初/各月记账汇率/月末牌价 = 第二节
数值，切勿用默认联网牌价）→ 执行测算。期望：

1. 每个外币货币性科目（银行/应收/应付/往来/借款）每月末建议调整为 0，无「应重估未重估」提示；
2. 已实现测算合计 = {realized:,.2f}，未实现重估合计 = {unreal:,.2f}，两者之和 = 客户账面净额
   {net:,.2f}，**审计测算与账面无差异**；
3. 非货币性外币科目（如{nonmon_hint}）不出现在重估建议中；
4. 货币资金分类确认页默认识别：银行存款为「货币性资产-货币资金」，应收/应付/往来/借款为
   「货币性资产-非货币资金」。

## 五、与工具的列映射预期

{mapping}

## 六、复现命令

```bash
cd "tests/fixtures/汇率损益测试集2/{folder}"
python generate.py
```

自检 27 项全部通过时退出码为 0。生成逻辑共享自 `_shared/core.py`（分录引擎、按日期截点滚动、
干净账恒等式校验）；控制台输出不含 emoji，Windows GBK 控制台可直接查看。
"""
    nonmon = [row for row in tb_rows.values()
              if row["ccy"] != book.functional and not book.accounts[row["acct"]]["monetary"]
              and abs(row["close_o"]) > 0.005]
    nonmon_hint = "、".join(sorted({book.accounts[row["acct"]]["name"] for row in nonmon})) or "固定资产/收入类外币行"
    return tpl.format(folder=folder, erp=erp, entity=entity, functional=book.functional,
                      foreign=foreign, feature=feature,
                      rates=rate_table(book), tb_file=tb_file, je_file=je_file,
                      tb_rows=len(tb_rows), je_lines=len(book.entries), vouchers=len(vouchers),
                      realized=realized, unreal=unreal, net=net,
                      pl_name=pl_name, mapping=mapping, nonmon_hint=nonmon_hint)


def top_readme():
    rows = []
    for folder, erp, entity in SETS:
        book = load_book(folder)
        tb_rows = book.roll_tb()
        vouchers = len({e["vno"] for e in book.entries})
        realized = r2(sum(g for (_, _, g) in book.realized_events))
        unreal = r2(sum(adj for (_, _, _, adj) in book.unreal_events))
        industry = {"01": "电子制造出口", "02": "化工制造", "03": "汽配制造", "04": "进出口贸易",
                    "05": "美国销售子公司", "06": "德国制造子公司", "07": "香港贸易物流",
                    "08": "国际货代", "09": "台资电子制造", "10": "海外工程承包"}[folder[:2]]
        rows.append("| %s | %s | %s | %s | %s | %s | %d | %s %.2f |" % (
            folder, erp, entity, book.functional, "/".join(book.foreign_ccys()),
            industry, vouchers, ("收益" if realized + unreal >= 0 else "损失"),
            abs(r2(realized + unreal))))
    matrix = chr(10).join(rows)

    tpl = """# 汇率损益测试集2：十家多 ERP 干净账全集

供审计工具箱「汇率损益测试」使用的第二批测试数据集。与第一批 `tests/fixtures/汇率损益测试集/`
（用友/金蝶/SAP/Oracle 四套、预埋审计差异）互补，本批为 **10 家虚构公司 x 10 种 ERP 版式 x 全部
干净账**：外币货币性项目每月末按月末牌价全额重估、已实现汇兑损益完整入账，用于验证工具对
合规账目的通过能力——**每套的期望结果都是审计测算与客户账面汇兑损益无差异**。

## 一、公司矩阵

| 目录 | ERP 版式 | 虚构公司 | 本位币 | 外币 | 行业 | 凭证数 | 账面汇兑净额 |
| --- | --- | --- | --- | --- | --- | --- | --- |
{matrix}

凭证数区间 105-134 张、JE 明细 240-349 行，与第一批标准集规模相当；每套细节见各自 README。

## 二、统一口径（十套共用）

- 会计期间均为 2026-01-01 至 2026-06-30；报告期同此。
- CNY 本位币公司（01-04、08-10）统一使用对 CNY 虚构牌价：USD 期初 7.1030（记账 7.1050→7.1680、
  月末 7.1120→7.1800）、EUR 期初 7.8210（记账 7.8300→7.8850、月末 7.8380→7.9000）、
  HKD 期初 0.9088、JPY 期初 0.04795（逐月见各套 README 第二节）。
- 外币本位币公司使用虚构交叉汇率：05（USD 本位币）EUR/USD 期初 1.1010；06（EUR 本位币）
  USD/EUR 期初 0.9050、CNY/EUR 期初 0.1275；07（HKD 本位币）USD/HKD 期初 7.8020、
  CNY/HKD 期初 1.0980。
- 干净账四原则：
  1. 所有外币分录按当月记账汇率入账，本位币金额 = round(原币 x 汇率, 2)；
  2. 外币货币性科目（银行/应收/应付/关联往来/借款）每月末按月末牌价全额重估；
  3. 已实现损益 = 实际本位币收付 - 滚动基础释放额；结算走整票结清，资金结汇按
     「滚动本位币余额 / 滚动原币余额」比例释放（与引擎分配口径一致）；
  4. TB 期初本位币余额 = 期初原币 x 期初牌价（上年末已重估的延续）。

## 三、版式覆盖（对引擎映射与形态识别的覆盖面）

- JE 金额形态：借贷分列（原币+本位币双口径，01-04、08-10）、英文净额+方向列（05，S/H）、
  中文净额+借贷方向列（07）、Entered/Accounted 借贷分列（06）。
- TB 余额形态：正数+方向列（01、03、04、07、08、09）、借正贷负带符号净额（02、05、06）、
  期初/期末借贷分列（10）；两行复合表头（03 金蝶 K/3）。
- 币种列形态：逐行全填（默认）、只标外币/本位币行留空（05 SAP JE、08 浪潮 JE）、
  中文币名（01、03）与 ISO 代码（其余）、「币别」列名（07）。
- 日期形态：日期列（多数）、记账日期+业务日期双列（02）、Posting Date DD.MM.YYYY（05）、
  Effective Date dd-mmm-yyyy（06）、会计期间辅助列（02、05、06）。

## 四、验收流程（每套相同）

上传该套 TB 与 JE → 确认列映射（应全部自动识别）→ 报告期 2026-01-01 至 2026-06-30 →
汇率面板改用手动录入并按该套 README 第二节填入虚构牌价（工具默认联网牌价与虚构牌价不一致，
务必手动录入）→ 执行测算 → 核对该套 README 第四节的四条干净账预期。

## 五、目录结构与复现

每套一个目录：两份 xlsx（TB + JE）、`generate.py`（生成 + 27 项自检一体）、`README.md`。
共享引擎在 `_shared/`：`core.py`（分录引擎、按日期截点滚动余额、干净账恒等式与文件自检）、
`renderers.py`（十种 ERP 版式渲染器）、`make_readmes.py`（从模型生成本批全部 README）。

全量复现与自检（10 套循环，任一失败退出码非 0）：

```bash
cd tests/fixtures/汇率损益测试集2
for d in 0*/ 1*/; do (cd "$d" && python generate.py) || echo "FAIL: $d"; done
```
"""
    return tpl.format(matrix=matrix)


def write_top():
    path = os.path.join(ROOT, "README.md")
    with open(path, "w", encoding="utf-8") as f:
        f.write(top_readme())
    print("written", path)


def main():
    for folder, erp, entity in SETS:
        path = os.path.join(ROOT, folder, "README.md")
        with open(path, "w", encoding="utf-8") as f:
            f.write(readme(folder, erp, entity))
        print("written", path)


if __name__ == "__main__":
    main()
    write_top()
