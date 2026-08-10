# FY27 WP服务单生成工具

根据系统导出的 WP 服务单和 FY27 Section List，自动生成 AUD2026、IPO、IPO archive、AUD2025 及逐服务单方案，完成 Section 数量回填、Outlook Hours 核对和 SER 测算。

WP 服务单和 Section List 均按表头名称识别字段，输入列顺序可以变化；不要修改字段名称。

本仓库不包含任何真实客户、项目、订单、人员或项目工时数据。代码内置标准 SER 工时占比和 Rate；`templates/FY27+WP服务单.xlsx.b64` 是脱敏空白模板的文本资源，程序首次运行时自动还原。

## 使用方式

准备同一文件夹中的两个系统导出文件。文件名不要求固定，只需符合关键词规则：

| 输入文件 | 文件名要求 | 可用示例 |
|---|---|---|
| WP服务单 | `.xlsx` 文件名包含 `WP服务单`，空格不影响识别 | `8月导出 WP 服务单 v2.xlsx` |
| Section List | `.xlsx` 文件名包含 `section list`，不区分大小写和空格 | `项目组 SECTION LIST final.xlsx` |

每类输入文件只能有一个。程序会忽略 `~$` 开头的 Excel 临时文件、服务方案模板、自动拆分文件和汇总结果。如果同类文件匹配到多个，程序会列出候选文件并停止，避免读错文件。

推荐目录示例：

```text
工作文件夹/
├─ FY27_WP服务单生成工具.exe
├─ 8月导出 WP 服务单 v2.xlsx
└─ 项目组 SECTION LIST final.xlsx
```

### audit-toolbox

`main.py` 提供工具箱要求的入口：

```python
def main(parent=None):
    ...
```

启动工具后选择包含上述两个文件的文件夹。程序会自动还原脱敏模板，并生成：

```text
FY27+WP服务单_自动拆分.xlsx
FY27+WP服务单汇总.xlsx
```

### Python

```powershell
pip install -r requirements.txt
python main.py
```

### Jupyter Notebook

打开 `生成项目组展示版_Jupyter.ipynb`，将 Notebook、Python 程序文件、`templates` 文件夹和两个系统导出文件放在同一文件夹，依次运行两个代码单元格。Python/Jupyter 版需要保留 `templates/FY27+WP服务单.xlsx.b64`；程序会在首次运行时自动还原模板。输出文件名为 `FY27+WP服务单汇总.xlsx`。

### 本地独立 EXE

将 `FY27_WP服务单生成工具.exe` 与两个系统导出文件放在同一文件夹即可双击运行。EXE 已内置脱敏模板，不需要另放 `templates` 文件夹，也不要求安装 Python。仓库同时保留可审阅的 Python 源码、脱敏模板文本资源和独立 EXE。

程序每次运行会更新同一目录下的 `FY27+WP服务单_自动拆分.xlsx` 和 `FY27+WP服务单汇总.xlsx`；如需保留旧结果，请先改名或移到其他目录。

## 内置 SER 规则与可选配置

程序默认使用以下内置规则：

| 级别 | Hours占比 | SER Rate |
|---|---:|---:|
| Manager | 8% | 2733 |
| Senior | 25% | 1199 |
| Staff | 58% | 683 |
| Intern | 9% | 173 |

如需调整，可在运行目录放置 `SER配置.xlsx` 覆盖默认值。使用第一个工作表，第一行为表头，第二至第五行依次为 Manager、Senior、Staff、Intern：

| A列 | B列 | C列 |
|---|---|---|
| 级别 | Hours占比 | SER Rate |

`Hours占比` 可以输入百分比或小数，四行合计必须为 100%；`SER Rate` 必须为正数。生成表会展示 Manager、Senior、Staff、Intern 四个级别，并保留比例、bill rate、上浮 5% 和 SER 金额公式。

## WP服务单输入文件

必须包含名称为 `业务` 的工作表，表头位于第一行。字段列顺序可以任意调整，也可以保留其他无关字段；建议直接使用系统完整导出，不要改列名。

### 必要字段

| 字段 | 用途 |
|---|---|
| Engagement Name | 项目名称及 AUD/IPO 分类 |
| WP服务单编号 | 匹配 Section List 和生成服务方案 |
| Outlook Hours | 与方案计算结果核对 |
| Booking Period Start-预审 | 预审开始及 IPO 分类 |
| Booking Period End-预审 | 预审结束及 IPO archive 分类 |
| Booking Period Start-年审 | 年审开始及 IPO 分类 |
| Booking Period End-年审 | 年审结束及 IPO archive 分类 |

### 建议保留字段

`Client Name`、`Engagement Code`、`WP FIC*`、`相关订单`、`Service Type`、`WP EIC`、`Audit EIC`、`Audit Report Date`、`底稿任务数量`、`项目状态`、`排班状态`。

建议字段缺失时，生成结果中的对应信息会留空，不影响核心生成流程。

## Section List 输入文件

读取文件中的第一个工作表，表头位于第一行。字段列顺序可以任意调整，也可以保留其他无关字段，但必要字段名需保留。

### 必要字段

| 字段 | 用途 |
|---|---|
| 所属WP服务单 | 与 WP服务单编号匹配 |
| Section | 匹配服务方案 Section |
| Entity数量（下单必填） | 计算标准参考工时 |
| 底稿数量 | 记录底稿数量 |
| 预算调整 | 计算调整工时 |

`Entity数量` 使用前缀识别，因此 `Entity数量（下单必填）` 等带说明文字的表头可以正常使用。

建议保留 `Outlook Hours`、`标准参考工时`、`Engagement Code`、`项目名称`、`WP EIC`、`WP FIC`、四个 Booking Period 字段和`相关订单`。`Section系统编号`不是必要字段。

## 计算和分类

- 同一服务单、同一 Section 的 Entity数量、底稿数量和预算调整会合并。
- 标准参考工时 = Entity数量 × 参考时间/Entity。
- Section Outlook Hours = 标准参考工时 + 预算调整。
- 项目总 Outlook Hours = Section 合计 × 1.1。
- 系统导出的文本型 Outlook Hours 会自动转换为数值。
- IPO 的 Booking Period Start 需落在 2026 或 2027 年。
- 2026年1月至3月开始，或2026年4月30日及以前结束的项目进入 `IPO archive`。
- `IPO archive` 不生成活动服务方案。

## 数据安全

禁止向仓库提交生产 Excel、生成结果、`SER配置.xlsx`、客户名称、项目编号、服务单号、订单号、人员姓名、项目工时或预算数据。仓库仅公开上述标准 SER 规则；`.gitignore` 默认阻止 Excel 和 ZIP 文件，仓库只保存脱敏空白模板的文本资源。
