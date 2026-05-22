# 固定资产底稿字段与资料映射

本文记录资料库中标准底稿的工作表、字段和建议标准字段名，供 `src/ingest/` 做字段映射，供 `src/rules/` 设计质检规则。

## 资料库文件角色

| 文件 | 角色 | 用途 |
| --- | --- | --- |
| `FY26_SOP K1 SWP 固定资产.xlsx` | SOP + 示例底稿 + 大量样例数据 | 理解程序逻辑、字段、易错点和示例公式 |
| `K1 SWP 固定资产 202YMMDD XYZ公司.xlsx` | 标准底稿模板 | 作为项目输出或读取的主要结构参考 |
| `K1 check list.xlsx` | 质检 checklist | 作为规则与人工复核清单来源 |
| `K.03.1 SAP-中精确度.xlsx` | 折旧 SAP 模板 | `CRA = Minimal` 等场景参考 |
| `K.03.1 SAP-高精确度.xlsx` | 折旧 SAP 模板 | `CRA = Low/Moderate/High` 等场景参考 |
| `K1 SWP 固定资产 202YMMDD XYZ公司（By item折旧测试）.xlsx` | By item 折旧测试模板 | 全量重新计算折旧参考 |
| `固定资产程序执行方法指引.pdf` | 程序执行方法指引 | 当前需 OCR 或源文件补充 |

## 案例库诊断结论

已对 `固定资产质检agent/案例库` 中 6 份较小脱敏底稿进行首轮读取诊断，跳过 1 份约 42MB 的大文件。

诊断报告见：`docs/case-workpaper-diagnostic.md`。

关键结论：

- 6 份底稿均能识别出主流程工作表：汇总、K.00、K.01、FA List、新增清单、处置清单、折旧测试、折旧政策复核。
- 工作表命名存在变体，例如 `K.01.1a FA list`、`FA list-24`、`FA list-`、`K.02.1b 新增清单`、`K.03.2 折旧测试TOD-by item测试`。
- 需要支持多行表头、合并单元格附近表头、以及带年度后缀的历史工作表。
- `FA list` 字段差异较大，常见未映射或需补充同义词包括 `卡片编码`、`入账日期`、`使用年限(月)`、`使用年限(年)`、`预计残值`、`预计使用期间数`。
- `新增清单` 和 `处置清单` 常见系统字段包括 `业务日期`、`单据编号`、`单据状态`、`单据类型`，需要结合清单类型判断字段含义，不能仅按“编号”模糊匹配。
- 标准 by item 折旧测试表字段较稳定；普通 TOD 折旧测试表更偏样本测试记录，字段不完全等同于资产明细清单。

## 标准底稿工作表

| 工作表 | 说明 | 对应模块 |
| --- | --- | --- |
| `汇总` | 程序目录、是否执行、不执行原因和注意事项 | `src/report/`、人工复核 |
| `K.00 Lead Sheet` | 基础信息、两期变动、预期分析 | `src/ingest/`、`src/rules/` |
| `K.01 Agree SL to GL` | 后推明细表与总账/明细账/清单核对 | `src/rules/` |
| `FA list` | 固定资产明细清单 | `src/ingest/`、`src/rules/` |
| `K.02.1 新增测试` | 新增详细测试 | `src/report/`、人工复核 |
| `新增清单` | 当期新增资产清单 | `src/ingest/`、`src/rules/` |
| `K.02.2 处置测试` | 处置/报废详细测试 | `src/report/`、人工复核 |
| `处置清单` | 当期处置资产清单 | `src/ingest/`、`src/rules/` |
| `K.03.1 SAP` | 折旧实质性分析程序 | `src/report/`、人工复核 |
| `K.03.2 折旧测试TOD` | 折旧详细测试 | `src/rules/` |
| `K.03.3 折旧政策复核` | 折旧政策合理性复核 | 人工复核 |

## 通用标准字段

| 中文字段 | 标准字段名 | 类型 | 说明 |
| --- | --- | --- | --- |
| 客户名称 | `client_name` | string | 底稿基础信息 |
| 期末 | `period_end` | date | 资产负债表日或测试截止日 |
| 分析日期 | `analysis_date` | date | 底稿编制或分析日期 |
| 可容忍误差 | `te` | decimal | Tolerable Error |
| 名义金额 | `sad` | decimal | Summary of Audit Differences 门槛 |
| 测试阈值 | `tt` | decimal | 测试门槛，来源需结合项目设置 |
| 记账本位币 | `currency` | string | 如 CNY |
| 公认会计准则 | `accounting_standard` | string | 如企业会计准则 |
| CRA | `cra` | enum | `Minimal`、`Low`、`Moderate`、`High` 等 |
| 实体类型 | `entity_type` | enum | 复杂实体、非复杂实体等 |

## 字段同义词补充

| 标准字段名 | 已确认同义词/变体 | 备注 |
| --- | --- | --- |
| `asset_id` | 固定资产编号、资产编号、资产编码、卡片编号、卡片编码 | 不应将 `单据编号` 自动映射为资产编号；处置清单中 `单据编号` 更可能是业务单据号 |
| `asset_name` | 固定资产名称、资产名称、名称 | 低风险同义词 |
| `asset_category` | 固定资产类别、资产类别、类别、企业类别名称、资产分类长描述、报表披露分类 | `报表披露分类` 和 `资产分类长描述` 需根据项目口径确认 |
| `start_date` | 入账开始日期、开始入账日期、开始使用日期、资本化日期、启用日期、入账日期 | `入账日期` 在部分底稿中替代入账开始日期 |
| `useful_life_months` | 使用寿命(月)、使用寿命（月）、使用寿命、使用年限(月)、使用年限(年)、预计使用期间数、计划使用年限 | 年和月需要单位转换 |
| `salvage_rate` | 残值率、预计净残值率、净残值率、预计残值、残值 | 金额型残值和比例型残值需区分 |
| `original_value` | 原值、资产原值、入账价值、固定资产原值、期初原值、处置原值、2025年末原值 | 期初/期末/处置原值需保留来源语义 |
| `accumulated_depreciation` | 累计折旧、累折、期初累计折旧、处置累计折旧、2025年末累计折旧 | 期初/期末/处置累计折旧需保留来源语义 |
| `impairment_provision` | 减值准备、减值、累计减值准备、固定资产减值 | 需区分本期减值和累计减值 |
| `net_value` | 净值、账面净值、资产净值、账面价值、2025年末净值、处置净值 | `账面价值` 可作为净值候选，但需结合上下文 |
| `addition_method` | 新增方式、增加方式、变动方式、卡片来源 | `变动方式` 可能同时表示新增或减少，需要结合 sheet 类型 |
| `disposal_date` | 处置日期、报废日期、减少日期、业务日期 | 在处置清单中 `业务日期` 可作为处置日期候选 |
| `disposal_method` | 处置/报废、减少方式、处置方式、报废方式、变动方式 | `变动方式` 需结合处置清单判断 |
| `current_depreciation` | 本期计提折旧、本期计提、折旧费用、本年折旧、账面计提折旧费用、本期应折旧金额 | 账面数、EY 重算数和差异应分列保存 |

## FA List 字段

客户可直接提供固定资产清单，**列名无需与标准底稿一致**。Agent 通过同义词与语义匹配映射到标准字段名，再检查是否满足「语义必需列」。

### 语义必需列（列名可不同）

| 层级 | 标准字段 | 含义 | 缺失时建议 |
| --- | --- | --- | --- |
| 核心 | `asset_id` 或 `asset_name` | 至少能标识单项资产 | 无标识则 `FAIL` |
| 核心 | `original_value` | 原值（或期末原值等口径，保留来源列名） | `FAIL` |
| 核心 | `accumulated_depreciation` | 累计折旧 | `FAIL`（无则金额勾稽无法进行） |
| 核心 | `net_value` | 净值 / 账面价值 / 资产净值 | `FAIL` |
| 强烈建议 | `asset_category` | 资产类别（用客户台账分类，不重分类） | `WARN` |
| 强烈建议 | `start_date` | 入账/启用/资本化日期 | `WARN` |
| 折旧相关 | `useful_life_months` 或可从「使用年限(年)」「预计使用期间数」换算 | 使用寿命 | `WARN` |
| 折旧相关 | `salvage_rate` 或「预计残值」（需区分金额与比例） | 残值率 | `WARN` |
| 可选 | `impairment_provision` | 减值准备 | 无则按 0 处理 |
| 可选 | `fully_depreciated_flag` / `fully_depreciated_date` | 提足折旧 | 仅辅助折旧测试 |

规则：`fa_list_required_fields` 检查**是否映射到**上述语义列，而非检查列名是否叫「固定资产编号」。

### 同义词扩展（客户自定义清单常见列名）

| 标准字段名 | 扩展同义词（持续补充） |
| --- | --- |
| `asset_id` | 固定资产编号、资产编号、资产编码、卡片编号、卡片编码、旧系统编码、序列号 |
| `asset_name` | 固定资产名称、资产名称、名称、规格型号、附加资产描述 |
| `asset_category` | 固定资产类别、资产类别、类别、企业类别名称、资产分类长描述、报表披露分类、旧系统分类 |
| `start_date` | 入账开始日期、开始入账日期、开始使用日期、资本化日期、启用日期、入账日期、首次购置日期 |
| `useful_life_months` | 使用寿命(月)、使用寿命（月）、使用寿命、使用年限(月)、使用年限(年)、预计使用期间数、计划使用年限、折旧年期 |
| `salvage_rate` | 残值率、预计净残值率、净残值率、预计残值、残值(%) |
| `original_value` | 原值、资产原值、入账价值、期初原值、期末原值、2025年末原值、未税成本（需业务确认） |
| `accumulated_depreciation` | 累计折旧、累折、期初累计折旧、期末累计折旧 |
| `net_value` | 净值、账面净值、资产净值、账面价值 |
| `impairment_provision` | 减值准备、减值、累计减值准备、固定资产减值 |

**禁止自动映射**（需结合 sheet 类型）：`单据编号`→`asset_id`（处置清单多为业务单号）；长段程序说明文字→任意字段。

### 字段对照表（标准底稿参考）

| 原始字段 | 标准字段名 | 类型 | 标准底稿中通常必需 | 质检方向 |
| --- | --- | --- | --- | --- |
| 固定资产类别 | `asset_category` | string | 是 | 不强行重分类，保留台账类别 |
| 固定资产编号 | `asset_id` | string | 是 | 必填、唯一 |
| 固定资产名称 | `asset_name` | string | 是 | 必填 |
| 入账开始日期 / 开始入账日期 | `start_date` | date | 是 | 不应晚于期末 |
| 使用寿命(月) | `useful_life_months` | integer | 是 | 应为正数 |
| 残值率 | `salvage_rate` | decimal | 是 | 通常在 0 到 1 之间 |
| 原值 | `original_value` | decimal | 是 | 非负 |
| 累计折旧 | `accumulated_depreciation` | decimal | 是 | 非负，通常不应超过原值 |
| 减值准备 / 减值 | `impairment_provision` | decimal | 建议 | 非负 |
| 净值 | `net_value` | decimal | 是 | 与原值、累计折旧、减值准备勾稽 |
| 已提足折旧 | `fully_depreciated_flag` | boolean/string | 可选 | 可辅助折旧测试 |
| 提足折旧时间 | `fully_depreciated_date` | date | 可选 | 可辅助折旧测试 |

金额关系：

```text
net_value ~= original_value - accumulated_depreciation - impairment_provision
```

默认容差建议：`0.01`。若项目设置另有要求，以项目设置为准。

## 新增清单字段

| 原始字段 | 标准字段名 | 类型 | 必需 | 质检方向 |
| --- | --- | --- | --- | --- |
| 固定资产类别 | `asset_category` | string | 是 | 保留台账类别 |
| 固定资产编号 | `asset_id` | string | 是 | 应能关联 FA List |
| 固定资产名称 | `asset_name` | string | 是 | 必填 |
| 入账开始日期 | `start_date` | date | 是 | 与新增期间匹配 |
| 使用寿命(月) | `useful_life_months` | integer | 建议 | 折旧测试需要 |
| 残值率 | `salvage_rate` | decimal | 建议 | 折旧测试需要 |
| 原值 | `original_value` | decimal | 是 | 非负 |
| 新增方式 | `addition_method` | string | 是 | 区分购置、在建工程转入、企业合并等 |
| 月份 | `depreciation_months` | decimal | 可选 | SAP/折旧测算辅助 |
| 权重 | `depreciation_weight` | decimal | 可选 | SAP/折旧测算辅助 |
| 加权后月份 | `weighted_months` | decimal | 可选 | SAP/折旧测算辅助 |

规则提示：

- 购置新增通常作为新增测试样本总体。
- 在建工程转入、企业合并、其他转入不应简单混入购置新增总体。
- 新增清单合计应与 K.01 后推明细表购置金额或相应新增金额核对。

## 处置清单字段

| 原始字段 | 标准字段名 | 类型 | 必需 | 质检方向 |
| --- | --- | --- | --- | --- |
| 固定资产类别 | `asset_category` | string | 是 | 保留台账类别 |
| 固定资产编号 | `asset_id` | string | 是 | 应能关联 FA List |
| 固定资产名称 | `asset_name` | string | 是 | 必填 |
| 原值 | `original_value` | decimal | 是 | 非负 |
| 累计折旧 | `accumulated_depreciation` | decimal | 是 | 非负 |
| 减值 / 减值准备 | `impairment_provision` | decimal | 建议 | 非负 |
| 净值 | `net_value` | decimal | 是 | 处置净值总体基础 |
| 处置日期 | `disposal_date` | date | 是 | 不应晚于期末 |
| 处置/报废 / 减少方式 | `disposal_method` | string | 是 | 区分出售、报废、其他减少 |
| 入账开始日期 | `start_date` | date | 可选 | 折旧测算辅助 |
| 使用寿命(月) | `useful_life_months` | integer | 可选 | 折旧测算辅助 |
| 提足折旧时间 | `fully_depreciated_date` | date | 可选 | 折旧测算辅助 |

规则提示：

- 处置测试总体通常是出售和报废减少的资产净值。
- 其他减少方式需要人工判断是否适用同一程序。
- 处置净值合计应与后推明细表对应处置金额核对。

## 折旧测试字段

| 原始字段 | 标准字段名 | 类型 | 必需 | 质检方向 |
| --- | --- | --- | --- | --- |
| 固定资产类别 | `asset_category` | string | 是 | 可用于分类分析 |
| 固定资产编号 | `asset_id` | string | 是 | 应唯一 |
| 固定资产名称 | `asset_name` | string | 是 | 必填 |
| 入账开始日期 | `start_date` | date | 是 | 影响计提月份 |
| 使用寿命(月) | `useful_life_months` | integer | 是 | 应为正数 |
| 残值率 | `salvage_rate` | decimal | 是 | 通常在 0 到 1 之间 |
| 原值 | `original_value` | decimal | 是 | 折旧基数 |
| 累计折旧 | `accumulated_depreciation` | decimal | 是 | 可辅助判断是否提足 |
| 减值准备 | `impairment_provision` | decimal | 建议 | 涉及减值后公式调整 |
| 净值 | `net_value` | decimal | 是 | 需与金额关系勾稽 |
| 本期计提折旧 | `current_depreciation` | decimal | 是 | 与重新计算结果比较 |
| 处置日期 | `disposal_date` | date | 条件必需 | 处置/报废资产折旧测算需要 |
| 原值减少金额 | `original_value_disposed` | decimal | 条件必需 | 处置/报废资产折旧测算需要 |

基础公式：

```text
annual_or_period_depreciation = original_value * (1 - salvage_rate) / useful_life_months * depreciation_months
difference = recalculated_depreciation - current_depreciation
```

进入人工复核的情形：

- 资产发生减值后折旧。
- 存在后续资本性支出。
- 使用寿命或残值率发生会计估计变更。
- 提足折旧时点复杂。
- 新增或处置日期不集中且标准权重无法覆盖。

## 报告输出字段建议

| 字段 | 含义 |
| --- | --- |
| `source_file` | 来源底稿或清单文件 |
| `source_sheet` | 来源工作表 |
| `source_row` | 来源行号，若可识别 |
| `procedure_code` | 程序编码，如 `K.01`、`K.03.2` |
| `asset_id` | 固定资产编号 |
| `rule_id` | 规则 ID |
| `field` | 涉及字段 |
| `severity` | `PASS`、`WARN`、`FAIL`、`NEED_REVIEW` |
| `message` | 问题描述 |
| `suggestion` | 建议处理动作 |

## 字段映射维护原则

- 原始列名可以多样，但标准字段名应稳定。
- 新增同义列名时，优先更新字段映射，不改规则逻辑。
- 业务口径变化时，同步更新 `docs/domain-glossary.md`。
- 如果某字段只在特定程序中必需，应标注为“条件必需”，不要简单设为全局必填。
