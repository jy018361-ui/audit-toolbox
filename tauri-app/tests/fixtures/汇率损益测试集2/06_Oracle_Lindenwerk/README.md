# 汇率损益测试集2 之 06_Oracle_Lindenwerk（Oracle EBS 版式，干净账）

审计工具箱「汇率损益测试」测试数据集。本套为**干净账**：外币货币性项目每月末按月末牌价
全额重估、已实现汇兑损益完整入账，预期工具测算差异为 **0**（审计测算合计应等于客户账面
汇兑损益净额）。

## 一、场景说明

- 虚构主体：Lindenwerk GmbH；记账本位币 **EUR**；外币：CNY、USD；期间 2026-01-01 至 2026-06-30。
- 业务画像：德国制造子公司，本位币 EUR，外币 USD/CNY。美元区客户销售与回款、美国芯片采购、母公司人民币资金支持（1 月收到 50 万、6 月全额归还）、美元→欧元结汇。英文表头（GL Journals/Trial Balance），Entered/Accounted 双口径，Effective Date 为 dd-mmm-yyyy，JE Batch/JE Name/Document No 分层编号。

## 二、汇率表（虚构，测试集统一设定）

| 币种 | 期初牌价 | 1-6月记账汇率（逐月） | 1-6月月末牌价（逐月） |
| --- | --- | --- | --- |
| USD | 0.905 | 0.905 / 0.904 / 0.902 / 0.903 / 0.901 / 0.9 | 0.904 / 0.903 / 0.901 / 0.902 / 0.9 / 0.898 |
| CNY | 0.1275 | 0.1276 / 0.1277 / 0.1274 / 0.1275 / 0.1272 / 0.1271 | 0.1275 / 0.1276 / 0.1273 / 0.1274 / 0.1271 / 0.1266 |

折算规则：本位币金额 = round(原币金额 x 当月记账汇率, 2)；月末重估后本位币余额 =
round(期末原币余额 x 当月月末牌价, 2)。

## 三、文件清单与规模

| 文件 | 内容 | 规模 |
| --- | --- | --- |
| `Oracle_科目余额表.xlsx` | 科目余额表（TB，科目 x 币种一行） | 24 行 |
| `Oracle_总账凭证明细.xlsx` | 凭证明细（JE） | 240 行 / 105 张凭证 |
| `generate.py` | 生成 + 自检一体脚本（`python generate.py` 重生成并跑 27 项自检） | — |

客户账面汇兑损益净额：**-1,470.14 EUR**（已实现 -29.44 + 未实现重估 -1,440.70），
全部计入 FX Gain/Loss。该净额即工具测算结果的期望值。

## 四、干净账验收预期

在审计工具箱「汇率损益测试」中：上传 TB 与 JE → 列映射按第五节自动识别（无需人工调整）→
报告期 2026-01-01 至 2026-06-30 → 汇率面板**改用手动录入**（期初/各月记账汇率/月末牌价 = 第二节
数值，切勿用默认联网牌价）→ 执行测算。期望：

1. 每个外币货币性科目（银行/应收/应付/往来/借款）每月末建议调整为 0，无「应重估未重估」提示；
2. 已实现测算合计 = -29.44，未实现重估合计 = -1,440.70，两者之和 = 客户账面净额
   -1,470.14，**审计测算与账面无差异**；
3. 非货币性外币科目（如Bank Charges、Revenue-US Sales）不出现在重估建议中；
4. 货币资金分类确认页默认识别：银行存款为「货币性资产-货币资金」，应收/应付/往来/借款为
   「货币性资产-非货币资金」。

## 五、与工具的列映射预期

TB 表头第 3 行：Company/Account/Account Name/Currency/Begin Balance (Entered)/Begin Balance (Accounted)/Period Net Dr (Entered)/Period Net Cr (Entered)/Period Net Dr (Accounted)/Period Net Cr (Accounted)/End Balance (Entered)/End Balance (Accounted)（净额带符号）。JE 表头第 3 行：JE Batch/JE Name/Document No/Effective Date/Period/Category/Account/Account Name/Currency/Entered Dr/Entered Cr/Accounted Dr/Accounted Cr。

## 六、复现命令

```bash
cd "tests/fixtures/汇率损益测试集2/06_Oracle_Lindenwerk"
python generate.py
```

自检 27 项全部通过时退出码为 0。生成逻辑共享自 `_shared/core.py`（分录引擎、按日期截点滚动、
干净账恒等式校验）；控制台输出不含 emoji，Windows GBK 控制台可直接查看。
