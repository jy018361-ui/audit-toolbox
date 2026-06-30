# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

审计工具箱是一个基于 tkinter 的 Windows 桌面应用，采用 "Hub + 插件" 架构。`tools.json` 是工具注册表，`launcher/` 负责加载与隔离运行各子工具。

当前注册的子工具（见 [tools.json](tools.json)）：

| id | vendor_dir | 入口 | 来源 |
|---|---|---|---|
| `fa_list` | `fa_list` | `main.py` | `tools/fa_list/` |
| `kanzhang` | `kanzhang` | `kanzhang_app.py` / `看账小工具+4.0.py` | `tools/kanzhang/` |
| `ts_manager` | `TS` | `main.py` | `tools/TS/` |
| `confirmation_progress` | `confirmation_progress` | `confirmation_app.py` | `modules/confirmation_progress/` |
| `Excel_Merger` | `Excel-Merger` | `main.py` | `modules/Excel-Merger/` |
| `file_list_directory` | `file-list-directory` | `main.py` | `modules/file-list-directory/` |

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
- **打包后**：`sys._MEIPASS` 下的 `modules/` 和 `tools/`（无 `vendor/`，无 `dev_root`）

入口文件名按 `entry` → `entry_dev` → `entry_vendor` 顺序在工具根下查找。

### 子工具加载与隔离（`launcher/runner.py`）

`launch_tool()` 用 `importlib.util.spec_from_file_location` 直接加载入口文件，并：

1. 暂存 `sys.path` / `cwd`，将工具根插入 `sys.path[0]`，`chdir` 进工具根
2. 用 `inspect.signature` 探测入口接受 `root` 还是 `parent` 参数（两种签名都仍然支持，新工具用 `root`）
3. 嵌入模式下 runner 自己 `tk.Toplevel(parent)` 并应用主题、深色标题栏，传给子工具
4. 子工具 `main()` 返回后，runner 兜底 `parent.wait_window(tool_window)` —— 因为部分子工具（如 `fa_list`）入口构建完 UI 就返回，不阻塞会让 Hub 误判工具已退出
5. `finally` 中恢复 `cwd` / `sys.path`，并通过 `_purge_tool_modules()` 卸载入口路径下 import 的所有模块，避免重复启动时残留状态

### 构建系统（`build_suite.py` + `suite.spec`）

- `suite.spec` 将 `tools.json`、`tools/`、`modules/` 全部打包进 exe，并 `excludes` 大量科学计算库（matplotlib、scipy、torch、tensorflow 等）控制体积
- `launcher/bundle_anchor.touch_bundle_deps()` 在 `suite_main.main()` 启动时被调用，作用是触发 PyInstaller 静态分析追踪 pandas/numpy/openpyxl/polars/python_calamine/fastexcel/windnd 等运行时才用到的依赖
- `--no-baseline` 之外默认还会调用 `build_fa_baseline()` / `build_kanzhang_baseline()` 单独打两个旧版基线 exe，用于在终端打印套件 vs 单包之和的体积对比（"1+1 < 2" 检查）
- `build_suite.py` 顶部有硬编码 `LEGACY_PATHS`（`C:\Users\Administrator\Downloads\...`），仅当 `tools/` 和 `modules/` 都没有该工具时才尝试，主仓常规流程不依赖

### LLM 辅助模块

`launcher/llm_client.py`、`llm_settings.py`、`llm_analysis.py` 提供 OpenAI 兼容协议的字段映射建议（FA List 字段对齐评审等）。Hub 主界面有"LLM 设置"入口（`open_llm_settings_dialog`）。新增子工具如要使用，可 import 这些模块；`suite.spec` 的 `hiddenimports` 已包含。

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

## 测试

`tests/` 下目前只有 `test_llm_client_fa_review.py`（unittest 风格，覆盖 LLM 字段映射评审逻辑与 `tools/fa_list/gui` 内的辅助函数）。GUI 部分没有自动化测试，验证子工具的完整流程仍需 `python suite_main.py` 手动跑。
