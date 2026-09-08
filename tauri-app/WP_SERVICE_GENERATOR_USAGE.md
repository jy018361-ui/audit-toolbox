# WP 服务单生成工具使用说明

本工具已集成到审计工具箱的 Tauri/Rust 桌面版。运行时不需要 Python，也不需要另放服务方案模板。

## 使用步骤

1. 将 WP 服务单、Section List 和“我的订单”放在同一个工作目录的第一层。
2. 在审计工具箱中打开“WP 服务单”，选择该目录。
3. 先点“检查输入”，确认三类文件均识别成功，再点“生成服务方案”。
4. 生成结果位于所选目录：
   - `FY27+WP服务单_自动拆分.xlsx`
   - `FY27+WP服务单汇总.xlsx`

每次生成会更新同名结果文件。需要保留旧结果时，请先将旧文件改名或移出工作目录，并确保结果文件没有在 Excel 中打开。

## 文件命名规则

输入文件名不要求固定为 `FY27 WP服务单.xlsx`、`FY27 Section List.xlsx` 或 `FY26 我的订单.xlsx`，只需符合下列关键词规则：

| 输入文件 | 文件名要求 | 示例 |
| --- | --- | --- |
| WP 服务单 | 包含 `WP服务单`，空格不影响识别 | `9月导出 WP 服务单.xlsx` |
| Section List | 包含 `section list`，忽略空格和大小写 | `项目组 SECTION LIST final.xlsx` |
| 我的订单 | 包含 `我的订单`，空格不影响识别 | `FY26 我的订单.xlsx` |

- 支持 `.xlsx` 和工具箱统一支持范围内的 `.xls` 输入。
- 每类文件只能有一个；发现多个候选文件时程序会停止并列出文件名。
- `~$` 临时文件、文件名包含“汇总”或“自动拆分”的结果文件会被忽略。
- `FY27+WP服务单.xlsx` 是可选的自定义模板；未提供时使用程序内置脱敏模板。

## WP 服务单字段

必须包含名为 `业务` 的工作表，表头在第一行。字段顺序可以变化，可以保留其他无关字段，但不要修改必要字段名称。

| 必要字段 | 用途 |
| --- | --- |
| `Engagement Name` | 项目名称及 AUD/IPO 分类 |
| `WP服务单编号` | 匹配 Section List 并生成服务方案 |
| `Outlook Hours` | 与方案最终工时核对 |
| `Booking Period Start-预审` | 预审开始及 IPO 分类 |
| `Booking Period End-预审` | 预审结束及 IPO archive 分类 |
| `Booking Period Start-年审` | 年审开始及 IPO 分类 |
| `Booking Period End-年审` | 年审结束及 IPO archive 分类 |

建议同时保留 `相关订单`、`WP FIC` 或 `WP FIC*`、`Audit Report Date`、`Client Name`、`Engagement Code`、`Service Type`、`WP EIC`、`Audit EIC`、`底稿任务数量`、`项目状态`、`排班状态`。其中 `相关订单` 用于匹配“我的订单”；为空或未匹配时 CI/AI 按 0 计算，并在结果中列出。

## 我的订单字段

优先读取名为 `业务` 的工作表；没有时读取第一个工作表。字段顺序不限，必要字段为：

| 必要字段 | 用途 |
| --- | --- |
| `订单编号` | 与 WP 服务单的 `相关订单` 匹配 |
| `CI Hours` | 从 Section Hours 中扣减 CI 工时 |
| `AI Hours` | 从 Section Hours 中扣减 AI 工时 |

订单编号匹配会忽略空格、大小写以及不同样式的短横线。CI/AI 空白按 0 处理；非数字会报出具体行号。同一订单编号重复且 CI/AI 数值不一致时程序会停止，避免重复口径不明确。

## Section List 字段

读取第一个工作表，表头在第一行。字段顺序不限，必要字段为：

| 必要字段 | 用途 |
| --- | --- |
| `所属WP服务单` | 与 `WP服务单编号` 匹配 |
| `Section` | 匹配模板中的 Section |
| `Entity数量...` | 计算标准参考工时；表头以前缀识别 |
| `底稿数量` | 回填底稿数量 |
| `预算调整` | 调整 Section 工时 |

建议保留 `Outlook Hours`。它用于 `FSO Pilot`、`Others` 等没有固定参考工时的 Section，以及无法逐项匹配模板的 Section。相同服务单、相同 Section 的 Entity 数量、底稿数量、预算调整和 Outlook Hours 会自动合并；非模板 Section 会按服务单汇总到 `Others`。

## 工时与 SER 口径

- `C_货币资金（除函证程序）` 的参考时间/Entity 为 `3`。
- `C_货币资金_银行函证` 的参考时间/Entity 为 `10`。
- 标准 Section Hours = Entity 数量 × 参考时间/Entity。
- Section Outlook Hours = 标准 Section Hours + 预算调整；无固定参考时间时使用 Section List 的 Outlook Hours。
- Hours 调整 =（Section Outlook Hours 合计 - CI Hours - AI Hours）× 10%。
- 最终 Outlook Hours = Section Outlook Hours 合计 - CI Hours - AI Hours + Hours 调整。
- SER 默认占比为 Manager 8%、Senior 25%、Staff 58%、Intern 9%；Rate 分别为 2733、1199、683、173，生成表继续计算 5% 上浮后的 SER。

可在工作目录放置 `SER配置.xlsx` 覆盖默认 SER。第一张表第 2 至 5 行依次为 Manager、Senior、Staff、Intern，B 列为 Hours 占比，C 列为 Rate；比例合计必须为 100%，Rate 必须为正数。

## 性能与数据安全

生成文件保持自动计算，但不要求 Excel 在每次打开时强制重算整个工作簿，并使用较简单的 Section 公式。批量修改时建议一次性粘贴数据并等待本轮计算完成。

不要向 Git 提交真实客户、项目、订单、人员、工时、预算数据或生成结果。仓库只保存代码、测试规则和脱敏模板资源。
