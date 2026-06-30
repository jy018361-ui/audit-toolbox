# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

审计工具箱是一个基于 tkinter 的 Windows 桌面应用，采用 "Hub + 插件" 架构。`tools.json` 是工具注册表，`launcher/` 负责加载与隔离运行各子工具。

当前注册的子工具（见 [tools.json](tools.json)）：

| id | vendor_dir | 入口 | 来源 |
|---|---|---|---|
| `fa_list` | `fa_list` | `main.py` | `tools/fa_list/` |
| `kanzhang` | `kanzhang` | `entry_dev: 看账小工具+4.0.py` / `entry_vendor: kanzhang_app.py`（自动选择） | `tools/kanzhang/` |
| `ts_manager` | `TS` | `main.py` | `tools/TS/` |
| `confirmation_progress` | `confirmation_progress` | `confirmation_app.py` | `modules/confirmation_progress/` |
| `Excel_Merger` | `Excel-Merger` | `main.py` | `modules/Excel-Merger/` |
| `file_list_directory` | `file-list-directory` | `main.py` | `modules/file-list-directory/` |

## 环境要求

- Python 3.10+，Windows 10/11
- 项目含 `.venv/` 虚拟环境，开发前建议先激活：`.venv\Scripts\activate`

## 常用命令

```bash
# 安装依赖
pip install -r requirements.txt

# 开发模式启动 Hub（从 tools/、modules/ 实时加载子工具）
python suite_main.py

# 一键构建单文件 exe（输出到 dist/审计工具箱.exe）
python build_suite.py

# 仅同步 tools/、modules/ 到 vendor/（旧版兼容路径，一般用不到）
python build_suite.py --sync-only
python build_suite.py --no-baseline   # 跳过 FA / 看账单包基线构建
python build_suite.py --no-pip        # 跳过 pip install

# 运行测试
python -m unittest discover -s tests -v
python -m unittest tests.test_llm_client_fa_review -v   # 单个测试模块
```

## 核心架构

### 运行时流程

`suite_main.py` 先在 import tkinter 前调用 `SetProcessDpiAwareness(1)` 锁定进程 DPI，再启动 `launcher.hub_window.HubWindow`。Hub 用户点选工具后调用 `launcher.runner.launch_tool()` 动态加载入口。

### 工具源码查找顺序（`launcher/registry.py`）

- **开发模式**：`vendor/` → `modules/` → `tools/` → `dev_root`（`tools.json` 中各工具的绝对路径）
- **打包后（冻结模式）**：仅 `sys._MEIPASS` 下的 `modules/` 和 `tools/`，无 `vendor/`，无 `dev_root`，也不回退到 `dev_root`

入口文件名按 `entry` → `entry_dev` → `entry_vendor` 顺序在工具根下查找。

### 子工具加载与隔离（`launcher/runner.py`）

`launch_tool()` 用 `importlib.util.spec_from_file_location` 直接加载入口文件，并：

1. 暂存 `sys.path` / `cwd`，将工具根插入 `sys.path[0]`，`chdir` 进工具根
2. 用 `inspect.signature` 探测入口接受 `root` 还是 `parent` 参数（两种签名都仍然支持，新工具用 `root`）
3. 嵌入模式下 runner 自己 `tk.Toplevel(parent)`，通过 `launcher/ui_theme.py` 应用主题（`apply_app_theme`）和深色标题栏（`set_dark_title_bar`），传给子工具
4. 子工具 `main()` 返回后，runner 兜底 `parent.wait_window(tool_window)` —— 因为部分子工具（如 `fa_list`）入口构建完 UI 就返回，不阻塞会让 Hub 误判工具已退出
5. `finally` 中恢复 `cwd` / `sys.path`，并通过 `_purge_tool_modules()` 卸载入口路径下 import 的所有模块，避免重复启动时残留状态

### 构建系统（`build_suite.py` + `suite.spec`）

- `suite.spec` 将 `tools.json`、`tools/`、`modules/` 全部打包进 exe，并 `excludes` 大量科学计算库（matplotlib、scipy、torch、tensorflow 等）控制体积
- `launcher/bundle_anchor.touch_bundle_deps()` 在 `suite_main.main()` 启动时被调用，作用是触发 PyInstaller 静态分析追踪 pandas/numpy/openpyxl/polars/python_calamine/fastexcel/windnd 等运行时才用到的依赖
- `--no-baseline` 之外默认还会调用 `build_fa_baseline()` / `build_kanzhang_baseline()` 单独打两个旧版基线 exe，用于在终端打印套件 vs 单包之和的体积对比（"1+1 < 2" 检查）
- `build_suite.py` 顶部有硬编码 `LEGACY_PATHS`（`C:\Users\Administrator\Downloads\...`），仅当 `tools/` 和 `modules/` 都没有该工具时才尝试，主仓常规流程不依赖

### LLM 辅助模块（~4000 行，三个模块）

Hub 主界面有"LLM 设置"入口（`launcher/llm_settings.py` → `open_llm_settings_dialog`），
配置保存在 `%APPDATA%/AuditToolbox/llm_settings.json`。启用后，FA List 和看账工具可调用
OpenAI 兼容 API 辅助字段映射与导出分析。

#### `launcher/llm_client.py`（~2840 行）— 核心客户端

纯 Python 实现，不依赖 openai SDK，直接用 `urllib.request` 调用 OpenAI 兼容 API。
主要能力：

- **FA List 字段映射建议**（`suggest_field_mappings`）：输入表头、样例值、当前映射，
  返回缺失字段的补全建议（`LLMSuggestion`）。含多层回退重试（JSON 解析失败 → 逐行解析 → 关键词候选匹配）。
  高置信度（≥0.8）建议自动应用。
- **FA List 字段复核**（`review_fa_list_field_mappings`）：采用**盲评机制**——先将列名替换为匿名 ID
  发给模型，模型仅凭数据形态（样例值 + column_profiles）判断角色，再与脚本当前映射比对，
  避免模型被列名误导。检测问题类型：`wrong_column`（列错配）、`cross_period_inconsistent`（期初期末口径不一致）。
- **FA List 匹配键复核**（`review_match_key_columns`）：同样盲评，独立推断最佳匹配键列，
  含禁列过滤（折旧/原值/类别/日期等会变动的业务字段不能作为匹配键）、
  副编码优先（查找次级编码/卡片编号等辅助键）、数据驱动候选优先等复杂规则。
- **看账字段映射检测**（`check_kanzhang_field_mappings`）：一次调用完成两件事——
  fills（补全缺失字段映射）+ reviews（复核已映射字段是否异常）。
  同时自动判断金额方案（方案 A：单金额列+方向列 vs 方案 B：独立借贷列），
  方案互斥校验（若借贷建议为同一列则自动改判方案 A）。
- **合并辅助判断**（`generate_combined_fa_list_assistance`）：将映射建议、字段复核、匹配键复核
  合并为一次 LLM 调用，节省 API 消耗。
- **连接测试**（`test_connection`）：发送最小 ping 请求验证配置。
- **共享基础设施**：12 秒默认超时（`_fast_llm_settings`）、紧凑列描述（`_compact_llm_files`）、
  表头匿名化（`_build_blind_field_view` / `_build_blind_match_view`）等。

#### `launcher/llm_settings.py`（~147 行）— 配置 GUI

- `load_llm_settings()` / `save_llm_settings()`：JSON 持久化
- `open_llm_settings_dialog(parent)`：标准 Toplevel 设置弹窗（Base URL、模型名、API Key、超时秒数、思考模式开关），含"测试连接"按钮
- `is_llm_enabled()`：检查是否已启用且配置完整

#### `launcher/llm_analysis.py`（~1181 行）— 导出后分析

为导出 Excel 追加一个"LLM分析"Sheet，含自动生成的分析段落。
设计为**规则化优先 + LLM 兜底**：先用 pandas 计算结构化候选数据，
再交给 LLM 生成自然语言段落；LLM 不可用时规则化逻辑仍可独立产出可用的文本。

- **FA List 分析**（`append_fa_list_analysis_sheet`）：四段分析——
  总体概述（原值/折旧变动金额及比例）、大额变动示例（新增/处置前几大资产）、
  新增日期异常（入账日期不在当期）、疑似费用化（资产名含维修/耗材等关键词）。
  规则化回退由 `_build_fa_rule_based_analysis()` 保证离线可用。
- **看账分析**（`append_kanzhang_analysis_sheet`）：三段分析——
  科目发生额概览（全量目标科目借贷净额）、对方科目与凭证类型合并分析
  （按 80% 累计覆盖筛选主要对方科目及方向匹配）、透视分析月度波动趋势
  （Top 项目月度序列，峰值/低值月份识别）。
- 全部候选数据预处理（`_kanzhang_counterparty_candidates`、`_kanzhang_monthly_trends` 等）
  在本地完成，LLM 仅做文本解释，不接触原始数据。

## 关键约定

### 子工具入口签名

推荐使用 `main(root=None)`：

```python
def main(root=None):
    is_embedded = root is not None
    if root is None:
        root = tk.Tk()        # 独立运行
    MyApp(root)
    if not is_embedded:
        root.mainloop()       # 仅独立模式
    # 嵌入模式不调 mainloop()/wait_window()/grab_set()，runner 会兜底 wait_window
```

`main(parent=None)` 旧签名仍被 runner 兼容，但新工具不要再用。

### 嵌入模式硬性禁忌

1. 不要在嵌入入口里 `mainloop()` —— 会冲突卡死 Hub
2. 不要 `transient()` / `overrideredirect()` / `attributes('-toolwindow', ...)` —— 会破坏 runner 准备好的标准 Toplevel（最大化按钮等）
3. 不要在传入的 `root` 上 `grab_set()` —— 内部对话框可以用，根窗口不行
4. 不要调用 `SetProcessDpiAwareness()` —— Hub 已在 `suite_main.py` 设过；如确需在独立运行时设，放在 `if __name__ == "__main__":` 块里
5. 独立运行和嵌入运行的可见行为必须一致

### 接入新工具检查清单

来自 2026-05-19 的实战排查（详见 [AGENTS.md](AGENTS.md)）：

1. **入口文件名优先 ASCII**：`tools.json` 的 `entry` 指向 `main.py`，避免中文/空格/随机名。如果实际脚本是 `看账小工具+4.0.py` 这种，包一层 `main.py` 转发
2. **包装入口要把动态加载的模块注册到 `sys.modules`**：`@dataclass` 等运行时会回查模块对象，未注册会触发 `NoneType has no attribute '__dict__'`
3. **Hub 卡片不能双触发**：卡片点击 + 按钮点击同时绑定时注意事件冒泡，连点也要测
4. **要切换工具来源时改 `tools.json`，别只改 `tools/xxx/`**：因为查找顺序是 `vendor/` 优先
5. **控制台输出避开 `✅`/`❌` 等非 ASCII**：Windows `gbk` 控制台会 `UnicodeEncodeError`

### 多人协同 / 跨电脑构建

- 子工具源码各自维护：本仓自带的放 `tools/`，外部独立仓库 clone 到 `modules/<vendor_dir>`
- `tools.json` 是唯一注册入口；提 PR 时通常只改 `tools.json`，不必把模块源码也提到主仓
- 打包者本机拉齐 `tools/` + `modules/` 后跑 `python build_suite.py` 即可，无需手动 `--sync-only`

### 辅助工具与参考文档

- **`添加工具.bat`**：图形化添加工具入口，面向非程序员用户，双击即可在界面中填写工具名称、选择脚本文件完成注册（详见 `添加工具使用说明.md`）。
- **`AGENTS.md`**：面向 Codex 的平行指导文件，内容与 CLAUDE.md 高度重叠但版本较旧（仅列 2 个工具、部分约定已过时），以 CLAUDE.md 为准。
- **`CODE_QUALITY_REPORT.md`** / **`UI_UX_REVIEW.md`**：历史审查报告，非实时文档。
- **`scratchpad/`**：实验性代码，非正式功能。

## 测试

`tests/` 下目前只有 `test_llm_client_fa_review.py`（unittest 风格，覆盖 LLM 字段映射评审逻辑与 `tools/fa_list/gui` 内的辅助函数）。GUI 部分没有自动化测试，验证子工具的完整流程仍需 `python suite_main.py` 手动跑。
