# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

fa_list 是审计工具箱中的固定资产底稿工具，功能是：加载期初和期末两张固定资产表，按卡片编号做全外连接匹配，透视汇总，导出 FA List 及相关清单。

## 开发运行

```bash
# 在 fa_list 目录下独立运行（不经过 Hub）
python main.py

# 安装依赖
pip install -r requirements.txt
```

## 核心架构

### 数据处理管道

```
FileHandler（加载 Excel/CSV）
  → DataPreprocessor（匹配列标准化）
  → MergeEngine（全外连接，支持多列组合键）
  → PivotEngine（透视表，自动按资产类别 + 原值/折旧聚合）
  → Exporter（导出 xlsx/csv，含汇总表、FA List、新增/处置清单）
```

### GUI 三步骤向导

`MainWindow` 管理三个步骤页面，通过 `show_step(n)` 切换，步骤组件缓存在 `step_widgets` 字典中避免重复创建：

1. **选择文件并配置** (`FileAndMatchConfig`) — 选择期初/期末文件，配置匹配列（支持多列组合键）、原值列、折旧列、字段映射（资产类别、名称、日期、寿命、残值率等）
2. **补充清单映射（可选）** (`FileAndMatchConfig`, mode="supplement") — 加载新增清单和处置清单，按唯一识别码将新增方式/处置方式/处置原值等回填到合并数据
3. **选择导出列** (`ColumnSelector`) — 勾选要导出的列，确认后直接弹出保存路径并导出

### 关键模块职责

| 模块 | 职责 |
|------|------|
| `file_handler.py` | Excel/CSV 加载，Excel 转 CSV 缓存（`%TEMP%/excel_merge_cache/`），标题行自动检测（前3行中非空率 > 50% 的行），编码探测 |
| `merge_engine.py` | 多列组合键全外连接，自动对齐匹配列顺序，重复值检测（保留所有匹配，形成多对多关系） |
| `data_preprocessor.py` | 匹配列标准化：浮点整数值去 `.0`（`1100000.0` → `"1100000"`），日期/数字/文本类型自动检测，NaN 统一为空字符串 |
| `pivot_engine.py` | 透视表创建，空值填充为"未分类"，数值列自动转换 |
| `field_mapper.py` | 关键字自动匹配字段（名称、日期、寿命、残值率），计算净值、已提足折旧、提足折旧时间 |
| `exporter.py` | 多 Sheet 导出（FA List / 新增清单_BKD / 处置清单_BKD / 汇总表 / 透视表），折旧测算公式写入，残值率/使用寿命纠偏警告 |
| `summary_generator.py` | 固定资产变动汇总表，支持按新增/处置方式分拆与重分类 |
| `sheet_generator.py` | 生成 FA List 和 BKD 清单，处理字段映射和列顺序 |

### 多列组合键匹配

匹配列支持多选（`match_columns1` / `match_columns2` 是列表）。合并时多列值用 `||` 拼接为组合键，各列先经过标准化处理（去空格、去 `.0`、统一大小写）。

### 补充清单机制

Step 1 的补充清单允许用户额外加载"新增清单"和"处置清单"文件。系统按唯一识别码将清单中的信息（新增方式、处置方式、处置原值等）回填到合并数据中，未匹配的资产单独记录并可在导出时生成独立 Sheet。

### 文件处理器双实例

`MainWindow` 维护两个 `FileHandler` 实例：`file_handler`（主文件）和 `supp_file_handler`（补充清单文件）。每次重新执行 Step 0 时会 `supp_file_handler.clear()` 重置补充清单。

### debug_logger.py

可选的调试日志模块，写入 NDJSON 到固定路径。所有核心模块通过 try/except 静默导入，不存在时退化为空函数，不影响正常运行。

### 编码处理

CSV 文件通过 `chardet` 检测编码，回退序列为 `[检测到的编码, utf-8, gbk, gb2312, latin-1]`。Excel 文件先转为 CSV 缓存再读取（大幅提速），缓存基于文件路径+Sheet名 MD5 命名，源文件修改时间更新时自动刷新。

## GUI 约定

- 所有 GUI 组件继承 `ttk.Frame`，通过 `pack(fill=tk.BOTH, expand=True)` 嵌入 `content_frame`
- 组件接受 `on_complete` 回调通知 MainWindow 步骤完成，`on_back` 回调返回上一步
- 耗时操作（合并、导出）在后台线程执行，通过 `root.after(0, ...)` 回到主线程更新 UI
- 步骤页面通过 `step_widgets` 字典缓存，`pack_forget()` 隐藏而非销毁，避免重复加载文件
