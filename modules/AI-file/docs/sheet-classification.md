# 工作表识别策略（名称 + 内容）

审计师在编制底稿时可能修改工作表名称，因此 Agent 不能只依赖 sheet 本名。识别策略为：**名称提示 + 内容特征** 综合打分，名称权重较低、内容权重较高。

## 识别流程

```text
读取工作表名称
        |
        v
名称打分（弱信号）：关键字、K.xx 编号、历史后缀 -24 等
        |
        v
扫描前 100 行 × 100 列，定位表头候选行
        |
        v
内容打分（强信号）：表头映射到的标准字段集合是否符合该 sheet 类型
        |
        v
综合得分 = max(名称分, 内容分) 或 名称与内容一致时加分
        |
        v
输出 sheet_kind + confidence + 识别依据
```

## 各类型内容特征（表头语义）

| sheet_kind | 名称常见提示 | 内容特征（映射到的标准字段） |
| --- | --- | --- |
| `fa_list` | FA list、固定资产清单、资产清单、K.01.1a | 同时出现：资产标识（编号/名称）+ 原值 + 累计折旧 + 净值；可选类别、入账日期、使用寿命、残值率 |
| `addition_list` | 新增清单、K.02.1b 新增 | 出现 `addition_method` 或「新增方式」；有原值；通常无「处置日期」 |
| `disposal_list` | 处置清单 | 出现 `disposal_date` / `disposal_method` 或处置/减少方式；有原值、累计折旧、净值 |
| `depreciation_tod` | K.03.2、折旧测试、by item | 出现 `current_depreciation` + 使用寿命/残值率 + 原值；by item 表头更完整 |
| `depreciation_tod_sample` | K.03.2 折旧测试TOD（无 by item） | 偏样本测试：样本数量、样本类型、差异、证据描述；资产字段不完整 |
| `lead` | K.00、Lead | TE、SAD、客户名称、期末、分析日期 |
| `rollforward` | K.01、Agree SL to GL | 后推、期初、本期增加、原值、累计折旧 |
| `summary` | 汇总 | 程序页、执行、不执行的原因 |
| `sap` | K.03.1、SAP | CRA、实质性分析程序、实体类型 |
| `depreciation_policy` | K.03.3、折旧政策复核 | 折旧方法、使用寿命、预计净残值、政策 |

## 名称变体处理

- 忽略首尾空格、大小写（英文部分）。
- 识别 `FA list-24`、`FA list-`、`K.01.1a FA list` 等为 `fa_list` 变体。
- `K.02.1b 新增清单` 与 `新增清单` 同为 `addition_list`。
- 若名称无法判断（如 `Sheet1`、审计师自定义名），**完全依赖内容打分**。
- 若名称与内容冲突（名称像 lead，内容像 fa_list），以 **内容分更高** 为准，并在诊断中标记 `name_content_mismatch`。

## 排除规则

以下工作表不纳入业务识别，标记为 `skip`：

- `SkywindSettingSheet`
- `DS_INTERNAL_*`
- 明显归档/说明页且无资产表头特征

## 实现位置

- 逻辑代码：`src/ingest/sheet_classifier.py`
- 字段映射：`src/ingest/field_mapping.py`
- 诊断入口：`src/ingest/diagnose.py` 或 `scripts/diagnose_workbook.py`
