# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

TS (Timesheet Pivot Tool) 是审计工具箱的子工具，用于扫描、加载 Timesheet 数据文件（Excel/CSV），按"经理"或"项目"两个维度进行透视汇总，支持条件筛选与一键导出。UI 采用 tkinter，数据处理依赖 openpyxl、python_calamine、xlsxwriter，可选使用 polars 加速。

在 `tools.json` 中注册为 `ts_manager`，由 Hub 通过 `main(root=None)` 入口动态加载运行。

## 文件结构

```
TS/
├── main.py          # 入口包装：动态加载 cop123213y.py，调用 TimesheetPivotApp
├── cop123213y.py    # 主实现（~2800行）：TimesheetPivotApp + 数据模型 + 导出逻辑
└── CLAUDE.md
```

## 启动方式

```bash
# 独立运行（不通过 Hub）
python main.py

# 通过 Hub 启动（开发模式）
cd .. && python suite_main.py
```

## 核心架构

### 入口层 (`main.py`)
- 通过 `importlib.util` 动态加载 `cop123213y.py` 为 `ts_tool_impl` 模块
- 遵循 Hub 入口签名约束：`main(root=None)`，嵌入式时不调用 `.mainloop()`
- 实例化 `TimesheetPivotApp(root)` 完成 UI 构建

### 主应用类 (`TimesheetPivotApp`)
- **初始化**：设置窗口几何（980-1360x360-560），构建滚动 Canvas 容器和 UI 面板
- **数据加载**：支持 openpyxl / python_calamine 读取 Excel，含 CSV 自动检测编码和分隔符。支持 polars 缓存加速（缓存目录 `%TEMP%/timesheet_polars_cache`）
- **UI 面板**：
  1. 目标文件选择（支持浏览、快速加载/全量扫描切换、标题行设置）
  2. 条件筛选（字段 + 多值选择，按 Department Name 默认筛选 ASU Delivery Center ZZ-WP）
  3. 透视配置选择（by经理 / by项目 两套预设或自定义）
  4. 透视结果查看 + 一键导出 Excel
- **导出**：使用 xlsxwriter 生成带格式的 Excel 透视表

### 数据模型
- `DataSource`：记录原始路径、文件类型、Sheet 名、分隔符、编码、标题行、列头
- `TaskContext`：后台任务状态跟踪（进度、取消、超时、计时）
- `PostProcessState`：透视后处理（重复行标签填充）
- `ProgressWindow`：模态进度对话框，支持取消

### 内置预设
- **默认文件夹**：Timesheet summary FY26 的 UNC 路径
- **默认筛选**：Department Name = "ASU Delivery Center ZZ-WP"
- **手动筛选缓存**：预置了 30+ 个 Department Name 选项

## 注意事项
- 编码声明为 `# -*- coding: utf-8 -*-`，所有文件读写必须保持 UTF-8
- 数据处理可选 polars（需 `fastexcel`），不可用时回退到 openpyxl/pandas
- 入口 `main(root=None)` 签名是硬性约束，由上层 runner 校验，不可修改参数名
