# FY27 WP服务单生成工具

根据系统导出的 WP 服务单和 FY27 Section List，自动生成 AUD2026、IPO、IPO archive、AUD2025 及逐服务单方案，完成 Section 数量回填、Outlook Hours 核对和 SER 测算。

本仓库不包含任何真实客户、项目、订单、人员或项目工时数据。代码内置标准 SER 工时占比和 Rate；`templates/FY27+WP服务单.xlsx.b64` 是脱敏空白模板的文本资源，程序首次运行时自动还原。

## 使用方式

准备同一文件夹中的两个系统导出文件：

```text
FY27 WP服务单.xlsx
FY27 section list.xlsx
```

### audit-toolbox

`main.py` 提供工具箱要求的入口：

```python
def main(parent=None):
    ...
```

启动工具后选择包含上述两个文件的文件夹。程序会自动复制脱敏模板，并生成：

```text
FY27+WP服务单_自动拆分.xlsx
FY27+WP服务单汇总.xlsx
```

### Python

```powershell
pip install -r requirements.txt
python main.py
```

### 本地独立 EXE

本地构建的 `FY27_WP服务单生成工具.exe` 与两个系统导出文件放在同一文件夹即可双击运行。EXE 不要求安装 Python；公共仓库仅发布可审阅的 Python 源码和脱敏模板资源。

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

`Hours占比` 可以输入百分比或小数，四行合计必须为 100%；`SER Rate` 必须为正数。生成表会保留比例、费率和公式，但隐藏职级及费率名称。

## FY27 WP服务单.xlsx

默认读取工作表 `业务`。建议直接使用系统完整导出，不要改列名。

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

## FY27 section list.xlsx

默认读取第一个工作表。字段列位置可以变化，但字段名需保留。

### 必要字段

| 字段 | 用途 |
|---|---|
| 所属WP服务单 | 与 WP服务单编号匹配 |
| Section | 匹配服务方案 Section |
| Entity数量（下单必填） | 计算标准参考工时 |
| 底稿数量 | 记录底稿数量 |
| 预算调整 | 计算调整工时 |

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
