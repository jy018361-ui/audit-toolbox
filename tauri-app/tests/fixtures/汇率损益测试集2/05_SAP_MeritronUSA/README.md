# 汇率损益测试集2 之 05_SAP_MeritronUSA（SAP S/4 版式，干净账）

审计工具箱「汇率损益测试」测试数据集。本套为**干净账**：外币货币性项目每月末按月末牌价
全额重估、已实现汇兑损益完整入账，预期工具测算差异为 **0**（审计测算合计应等于客户账面
汇兑损益净额）。

## 一、场景说明

- 虚构主体：Meritron USA Inc.；记账本位币 **USD**；外币：EUR；期间 2026-01-01 至 2026-06-30。
- 业务画像：美国销售子公司（集团海外平台），本位币 USD，外币 EUR。欧元区客户销售与回款、本土销售、母公司美元关联采购、预付保险摊销、员工备用金、欧元→美元结汇、美元购汇补欧元头寸。英文表头（FBL3N/FAGLLB03 风格），JE 币种列只标外币（USD 行留空），Dr/Cr 取值 S/H，Posting Date 为 DD.MM.YYYY。期末重估凭证形态为 FAGL_FCV（原币 0、仅调本位币）。

## 二、汇率表（虚构，测试集统一设定）

| 币种 | 期初牌价 | 1-6月记账汇率（逐月） | 1-6月月末牌价（逐月） |
| --- | --- | --- | --- |
| EUR | 1.101 | 1.102 / 1.104 / 1.106 / 1.105 / 1.108 / 1.109 | 1.103 / 1.105 / 1.107 / 1.106 / 1.109 / 1.112 |

折算规则：本位币金额 = round(原币金额 x 当月记账汇率, 2)；月末重估后本位币余额 =
round(期末原币余额 x 当月月末牌价, 2)。

## 三、文件清单与规模

| 文件 | 内容 | 规模 |
| --- | --- | --- |
| `SAP_科目余额表.xlsx` | 科目余额表（TB，科目 x 币种一行） | 22 行 |
| `SAP_凭证明细.xlsx` | 凭证明细（JE） | 259 行 / 123 张凭证 |
| `generate.py` | 生成 + 自检一体脚本（`python generate.py` 重生成并跑 27 项自检） | — |

客户账面汇兑损益净额：**4,111.30 USD**（已实现 239.16 + 未实现重估 3,872.14），
全部计入 FX Gain/Loss。该净额即工具测算结果的期望值。

## 四、干净账验收预期

在审计工具箱「汇率损益测试」中：上传 TB 与 JE → 列映射按第五节自动识别（无需人工调整）→
报告期 2026-01-01 至 2026-06-30 → 汇率面板**改用手动录入**（期初/各月记账汇率/月末牌价 = 第二节
数值，切勿用默认联网牌价）→ 执行测算。期望：

1. 每个外币货币性科目（银行/应收/应付/往来/借款）每月末建议调整为 0，无「应重估未重估」提示；
2. 已实现测算合计 = 239.16，未实现重估合计 = 3,872.14，两者之和 = 客户账面净额
   4,111.30，**审计测算与账面无差异**；
3. 非货币性外币科目（如Interest & Bank Fees、Revenue-EUR Sales）不出现在重估建议中；
4. 货币资金分类确认页默认识别：银行存款为「货币性资产-货币资金」，应收/应付/往来/借款为
   「货币性资产-非货币资金」。

## 五、与工具的列映射预期

TB 表头第 3 行：Company Code/G/L Account/Account Name/Currency/Period/Opening Balance (Doc. Curr.) 期初原币余额/Debit (Doc. Curr.) 原币借方发生额/Credit (Doc. Curr.) 原币贷方发生额/Balance (Doc. Curr.) 期末原币余额/Opening Balance (Local Curr.) 期初本位币余额/Debit (Local Curr.) 本年累计借方发生额/Credit (Local Curr.) 本年累计贷方发生额/Balance (Local Curr.) 期末本位币余额（净额带符号）。JE 表头第 3 行：Company Code/Document No./Document Type/Posting Date/Period/Reference/Text/Currency/Amount in Doc. Curr. 原币金额/Dr/Cr/Amount in Local Curr. 本位币金额/User Name。

## 六、复现命令

```bash
cd "tests/fixtures/汇率损益测试集2/05_SAP_MeritronUSA"
python generate.py
```

自检 27 项全部通过时退出码为 0。生成逻辑共享自 `_shared/core.py`（分录引擎、按日期截点滚动、
干净账恒等式校验）；控制台输出不含 emoji，Windows GBK 控制台可直接查看。
