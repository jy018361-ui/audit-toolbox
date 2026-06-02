# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

看账工具（kanzhang）是审计工具箱的"凭证导入、科目筛选、透视与导出"子工具，基于 tkinter 的单文件桌面应用（`kanzhang_app.py`，约 4000 行）。

## 运行方式

```bash
# 独立运行（开发调试）
python kanzhang_app.py

# 通过 Hub 启动（嵌入式模式）
python ../suite_main.py
```

## 核心架构

整个应用集中在 `kanzhang_app.py` 中，分层如下：

### 类结构（5 个类 + 1 个入口函数）

| 类/函数 | 行号 | 用途 |
|---------|------|------|
| `ExportCancelled` | 46 | 导出中断异常 |
| `ExportPerfTracer` | 50 | JSONL 性能追踪器，记录各步骤耗时并输出 Top20 慢步骤 |
| `ProgressWindow` | 95 | 模态进度弹窗，支持可选的取消按钮 |
| `DraggableListbox` | 137 | 支持拖拽、Shift/Control 多选、Ctrl+A 全选的自定义 Listbox |
| `PivotDesignerDialog` | 257 | 透视表设计器弹窗，支持将字段拖拽到 行/列/值 区域 |
| `AuditApp_V70_2` | 366 | 主应用类，包含全部业务逻辑和 UI |
| `main(parent=None)` | 4013 | 入口函数 |

### 主应用 `AuditApp_V70_2` 核心流程

```
加载数据 (load_file) → 科目筛选 (prepare_filter_data) → 导出&透视 (start_process_flow)
```

**关键内部状态：**

- **影子文件（shadow）**：加载 Excel/CSV 后，后台线程创建 Parquet 格式的临时影子文件（`_start_shadow_parquet_background`），后续读取全部走 Parquet 路径，大幅提升性能
- **全量缓存（full_cache）**：后台线程维护完整 DataFrame 缓存（`_start_full_cache_background`），用于科目扫描等需要全表遍历的场景
- **三种方案（Scheme）**：通过列映射自动检测
  - 方案 A：单列金额 + 方向列（`role_amt` + `role_dir`）
  - 方案 B：借贷分列（`role_dr` + `role_cr`）
  - 方案 C：通过 `_ensure_net_column_polars` 统一转为净额列
- **批次管理**：支持将科目分为多个批次，每批独立导出

### 数据加载链

```
load_file() → process_load() → _universal_loader() → _read_shadow_parquet() / _read_text_file_with_fallback()
                ↓
         auto_map_columns() → build_table() → Treeview 预览
```

1. `_universal_loader` 是加载中枢：优先读 Parquet 影子文件，回退到 CSV/Excel 原始加载
2. Excel 加载优先级：`python_calamine` > `openpyxl`（仅预览）> `polars`
3. 文本文件（CSV/TSV）自动检测分隔符和编码（`_read_text_file_with_fallback`）
4. `_create_shadow_parquet` 将原始文件转为 Parquet，后续全量读取走 Polars 路径

### 导出流程

```
start_process_flow() → run_export() → _run_export_single()（每批次）
                                          ├── _preprocess_and_filter_with_polars()  # 筛选
                                          ├── build_voucher_pivot()                 # 透视
                                          ├── apply_je_2_0_matching()               # JE 2.0 匹配
                                          └── _apply_output_formatting()             # 格式输出
```

### 列映射系统

`auto_map_columns()` 通过 `ROLES`（角色定义）和 `KEYWORDS`（关键词字典）自动匹配用户表头到内部角色（`role_id`, `role_acc`, `role_entity`, `role_date`, `role_summary`, `role_dr`, `role_cr`, `role_amt`, `role_dir`）。匹配逻辑：
- `_find_col_strict`：精确匹配 + 关键词包含匹配
- `_is_combined_dr_cr_header`：检测贷方金额列是否同时包含借方关键词，避免误匹配

### 拖拽交互

`DraggableListbox` 同时服务两个场景：
1. **透视表设计器**（`dialog_ref` 模式）：从源列表拖字段到 行/列/值
2. **主界面筛选框**（`app_ref` 模式）：在 源/目标/排除 三个穿梭框之间拖拽科目

## 重要注意事项

### 入口函数签名问题

当前 `main(parent=None)` 使用 `parent` 参数名，但项目级 CLAUDE.md 要求使用 `main(root=None)` 签名。runner 的签名检查可能拒绝启动。如需在 Hub 中运行，应将 `parent` 重命名为 `root`。

### 硬依赖

- **polars**：必须安装，启动时检查，缺失直接 `raise RuntimeError`
- **xlsxwriter**：可选，缺失仅弹出警告
- **python_calamine**：可选，缺失则使用 openpyxl 加载 Excel

### 临时文件

- 影子 Parquet/CSV 文件存储在 `tempfile.gettempdir()`，前缀 `shadow_`
- 应用关闭时自动清理（`_cleanup_shadow_files_on_exit`）
- 性能日志写入工具目录下的 `导入耗时日志.log` 和 `导出耗时日志.jsonl`

### 编码约定

- 读取文件时检测编码，写入时沿用原编码（`_read_text_file_with_fallback`）
- 所有用户可见文本使用中文
