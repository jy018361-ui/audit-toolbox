# 固定资产质检 Checklist

本文沉淀资料库 `K1 check list.xlsx` 和标准底稿中的核心检查点。后续实现规则时，应优先从“可自动化检查”开始，无法仅靠结构化数据判断的项目进入人工复核。

## 检查点分级

| 等级 | 含义 | Agent 处理 |
| --- | --- | --- |
| `AUTO_FAIL` | 可由数据直接判断且明显错误 | 输出 `FAIL` |
| `AUTO_WARN` | 可由数据发现异常但需要业务确认 | 输出 `WARN` |
| `REVIEW` | 需要审计判断、证据阅读或项目背景 | 输出 `NEED_REVIEW` |
| `INFO` | 记录性或提示性事项 | 可写入报告备注 |

## 一、底稿范围与程序设计

| 检查点 | 检查描述 | 自动化等级 | 建议规则 ID |
| --- | --- | --- | --- |
| PM/TE/SAD 一致性 | PM、TE、SAD 应与 Canvas 或项目最终结果一致 | `REVIEW` | `materiality_consistency` |
| CRA/TT 正确性 | 各认定 CRA 正确，TT 取值正确 | `REVIEW` | `risk_threshold_consistency` |
| PSP 完整执行 | 应执行的 PSP 均已执行 | `REVIEW` | `psp_completion` |
| 拒绝执行理由 | 不执行某程序时，拒绝理由应恰当充分 | `REVIEW` | `procedure_waiver_reason` |
| 异常波动调查 | 超过门槛、性质异常或与预期不符的变动应调查并记录 | `REVIEW` | `unexpected_movement_investigation` |

Agent 规则化建议：

- 如果结构化底稿中“执行”字段为空，输出 `NEED_REVIEW`。
- 如果程序选择“不执行”但“不执行的原因”为空，输出 `FAIL`。
- 如果 `TE`、`SAD` 缺失，输出 `FAIL`。
- 如果 `TE`、`SAD` 与外部系统值不一致但无法自动核实来源，输出 `NEED_REVIEW`。

## 二、K.00 Lead Sheet

| 检查点 | 检查描述 | 自动化等级 | 建议规则 ID |
| --- | --- | --- | --- |
| 基础信息完整 | 客户名称、期末、分析日期、TE、SAD、准则、币种/单位应完整 | `AUTO_FAIL` | `lead_required_fields` |
| 本期余额核对 | 本期余额应与试算平衡表一致 | `REVIEW` | `lead_tb_reconciliation` |
| 上期余额核对 | 上期余额应与上年审定数一致 | `REVIEW` | `lead_prior_year_reconciliation` |
| 预期分析 | 应记录固定资产变动预期及依据 | `REVIEW` | `lead_expectation_analysis` |
| 异常变动调查 | 异常或不符合预期的变动应说明原因 | `REVIEW` | `lead_exception_investigation` |

## 三、K.01 Agree SL to GL

| 检查点 | 检查描述 | 自动化等级 | 建议规则 ID |
| --- | --- | --- | --- |
| 后推明细表存在 | 应获取或编制固定资产后推明细表 | `AUTO_FAIL` | `rollforward_exists` |
| 金额口径完整 | 原值、累计折旧、减值准备、净值应覆盖期初、本期变动、期末 | `AUTO_FAIL` | `rollforward_columns_complete` |
| 期末核对 | 期末余额应与总账、明细账、试算表或资产清单核对 | `REVIEW` | `rollforward_ending_reconciliation` |
| 差异调查 | 超过 `SAD` 的差异应调查 | `AUTO_WARN` | `rollforward_difference_over_sad` |
| 异常金额 | 累计折旧大于原值、净值为负等异常应提示 | `AUTO_FAIL` | `rollforward_abnormal_amounts` |

## 四、FA List

| 检查点 | 检查描述 | 自动化等级 | 建议规则 ID |
| --- | --- | --- | --- |
| 必需字段完整 | 类别、编号、名称、入账开始日期、使用寿命、残值率、原值、累计折旧、净值应完整 | `AUTO_FAIL` | `fa_list_required_fields` |
| 资产编号唯一 | 固定资产编号不应重复 | `AUTO_FAIL` | `unique_asset_id` |
| 金额非负 | 原值、累计折旧、减值准备、净值不应为负 | `AUTO_FAIL` | `asset_amount_non_negative` |
| 金额关系 | 原值 - 累计折旧 - 减值准备 应与净值基本一致 | `AUTO_FAIL` | `asset_value_consistency` |
| 日期合理 | 入账开始日期不应晚于期末日期 | `AUTO_WARN` | `asset_start_date_reasonable` |
| 使用寿命合理 | 使用寿命（月）应为正数 | `AUTO_FAIL` | `useful_life_positive` |
| 残值率合理 | 残值率通常应在 0 到 1 之间 | `AUTO_FAIL` | `salvage_rate_range` |

## 五、K.02.1 新增测试

| 检查点 | 检查描述 | 自动化等级 | 建议规则 ID |
| --- | --- | --- | --- |
| 新增清单字段完整 | 类别、编号、名称、入账开始日期、原值、新增方式应完整 | `AUTO_FAIL` | `addition_required_fields` |
| 新增清单核对 | 新增清单合计应与后推明细表购置金额核对 | `AUTO_WARN` | `addition_rollforward_reconciliation` |
| 差异超过 SAD | 新增清单与后推表差异超过 `SAD` 应调查 | `AUTO_WARN` | `addition_difference_over_sad` |
| 总体同质性 | 购置新增与在建工程转入、企业合并等应区分总体 | `REVIEW` | `addition_population_homogeneity` |
| 控制权转移证据 | TOD 支持性证据应关注控制权转移时点 | `REVIEW` | `addition_cutoff_evidence` |

## 六、K.02.2 处置测试

| 检查点 | 检查描述 | 自动化等级 | 建议规则 ID |
| --- | --- | --- | --- |
| 处置清单字段完整 | 类别、编号、名称、原值、累计折旧、减值、净值、处置日期、减少方式应完整 | `AUTO_FAIL` | `disposal_required_fields` |
| 处置清单核对 | 处置净值合计应与后推明细表处置金额核对 | `AUTO_WARN` | `disposal_rollforward_reconciliation` |
| 差异超过 SAD | 处置清单与后推表差异超过 `SAD` 应调查 | `AUTO_WARN` | `disposal_difference_over_sad` |
| 处置日期合理 | 处置日期不应晚于期末日期 | `AUTO_WARN` | `disposal_date_reasonable` |
| 处置完整性 | 应考虑重大经营变化是否导致资产报废或处置 | `REVIEW` | `disposal_completeness_review` |
| 总体同质性 | 出售/报废减少与其他减少方式应区分总体 | `REVIEW` | `disposal_population_homogeneity` |

## 七、K.03.1 折旧 SAP

| 检查点 | 检查描述 | 自动化等级 | 建议规则 ID |
| --- | --- | --- | --- |
| SAP 类型选择 | `CRA = Minimal` 通常使用中精确度；`CRA = Low/Moderate/High` 通常使用高精确度 | `REVIEW` | `sap_precision_selection` |
| CRA 一致 | SAP 中 CRA 应与 K.00 计价/计量认定 CRA 一致 | `REVIEW` | `sap_cra_consistency` |
| 实体类型 | 实体类型选择应与非复杂方法或抽样判断一致 | `REVIEW` | `sap_entity_type_consistency` |
| 特别风险 | 存在特别风险且不依赖控制或控制无效时，应执行 TOD | `REVIEW` | `sap_special_risk_tod_required` |
| SAP 证据不足 | SAP 证据不足时应补充详细测试 | `REVIEW` | `sap_insufficient_evidence` |

## 八、K.03.2 折旧 TOD / By Item

| 检查点 | 检查描述 | 自动化等级 | 建议规则 ID |
| --- | --- | --- | --- |
| 折旧清单字段完整 | 类别、编号、名称、入账开始日期、使用寿命、残值率、原值、累计折旧、净值、本期计提折旧应完整 | `AUTO_FAIL` | `depreciation_required_fields` |
| 折旧总体核对 | 本期计提折旧金额应与后推明细表核对 | `AUTO_WARN` | `depreciation_rollforward_reconciliation` |
| 重新计算差异 | 重新计算折旧与账面折旧差异超过容差应提示 | `AUTO_WARN` | `depreciation_recalculation_difference` |
| 差异超过 SAD | 单项或合计差异超过 `SAD` 应进一步核查 | `AUTO_WARN` | `depreciation_difference_over_sad` |
| 标准公式不适用 | 存在减值、后续资本性支出、寿命变更时，应人工复核公式 | `REVIEW` | `depreciation_formula_exception` |

## 九、K.03.3 折旧政策复核

| 检查点 | 检查描述 | 自动化等级 | 建议规则 ID |
| --- | --- | --- | --- |
| 政策三要素完整 | 折旧方法、使用寿命、预计净残值应清晰 | `REVIEW` | `depreciation_policy_complete` |
| 与上期一致 | 折旧政策与上期不一致时，应说明依据 | `REVIEW` | `depreciation_policy_change_reason` |
| 符合准则 | 折旧方法应反映经济利益预期消耗方式 | `REVIEW` | `depreciation_method_reasonable` |
| 年度复核 | 使用寿命和预计净残值应至少年度复核 | `REVIEW` | `depreciation_estimate_annual_review` |

## Agent 首批实现优先级

建议按以下顺序实现自动化规则：

1. `fa_list_required_fields`
2. `unique_asset_id`
3. `asset_amount_non_negative`
4. `asset_value_consistency`
5. `useful_life_positive`
6. `salvage_rate_range`
7. `asset_start_date_reasonable`
8. `addition_required_fields`
9. `disposal_required_fields`
10. `depreciation_required_fields`

涉及 Canvas、CRA、TE/SAD 外部一致性、证据充分性、拒绝执行理由恰当性等事项，优先进入人工复核，不在 MVP 中强行自动判断。
