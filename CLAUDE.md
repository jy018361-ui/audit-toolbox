# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

审计工具箱是一个面向审计/财务场景的 Windows 桌面工具箱，当前处于 **Tauri 迁移分支**（`migration/tauri-v2`）。
仓库同时存在两套栈：

| | 位置 | 状态 |
|---|---|---|
| **生产栈** | [`tauri-app/`](tauri-app/) | Tauri 2 + React 19/TS + 全 Rust 业务核心，九个工具的唯一生产实现 |
| **旧栈 / 金标** | `suite_main.py`、`launcher/`、`tools/`、`modules/`、`audit_engine/` | tkinter Hub + Python 内核，**不再参与生产运行和发布打包**，仅作迁移对照基线与回归测试 |

**默认在 `tauri-app/` 里干活**——该目录有自己的 [CLAUDE.md](tauri-app/CLAUDE.md)，描述 Tauri/Rust 架构、
命令白名单、worker 进程模型和发布门禁。本文件只在你需要读/改旧 Python 栈（做迁移对照、跑金标测试）时才有用。

`tools.json` 注册了九个工具，与 `tauri-app/public/tool-catalog.json` 的九个 id 一一对应：
`fa_list`、`kanzhang`、`ts_manager`、`confirmation_progress`、`Excel_Merger`、`file_list_directory`、
`audipick`、`audit_roll_forward`、`wp_service_generator`。
源码分布在 `tools/`（fa_list、kanzhang、TS）和 `modules/`（其余六个）。

## 环境要求

- Python 3.10+，Windows 10/11；仓库含 `.venv/`，开发前可先 `.venv\Scripts\activate`
- 生产栈另需 Node.js 22、Rust stable-msvc、Visual Studio C++ Build Tools（见 `tauri-app/CLAUDE.md`）

## 常用命令

```bash
pip install -r requirements.txt

# 运行金标回归测试（tauri-app 发布脚本 --legacy-regression 时也跑同一套）
python -m pytest -q tests
python -m unittest discover -s tests -p "test_*.py"     # 等价，unittest 风格
python -m pytest -q tests/test_tauri_engine.py          # 单个测试文件

# 旧 tkinter Hub（仅用于对照旧版行为，不是生产入口）
python suite_main.py
python build_suite.py
```

生产栈的启动/打包命令都在 `tauri-app/` 下执行，不要在根目录跑。

## 旧栈架构（做迁移对照时才需要）

### tkinter Hub

`suite_main.py` 在 import tkinter 前调用 `SetProcessDpiAwareness(1)` 锁定 DPI，再启动 `launcher.hub_window.HubWindow`。
点选工具后 `launcher.runner.launch_tool()` 用 `importlib.util.spec_from_file_location` 直接加载入口文件，
插入 `sys.path[0]`、`chdir` 进工具根，探测入口签名接受 `root` 还是 `parent`，
嵌入模式下由 runner 自己建 `tk.Toplevel(parent)` 并应用主题，返回后兜底 `parent.wait_window()`
（部分子工具建完 UI 就返回，不阻塞会让 Hub 误判已退出），最后 `_purge_tool_modules()` 卸载残留模块。

工具源码查找顺序（`launcher/registry.py`）：开发模式 `vendor/` → `modules/` → `tools/` → `dev_root`；
冻结模式只看 `sys._MEIPASS` 下的 `modules/` 和 `tools/`。入口名按 `entry` → `entry_dev` → `entry_vendor` 查找。

### `audit_engine/` —— 中间态 JSON Lines 引擎

Tauri 迁移早期曾用它作 Python sidecar（`audit_engine_entry.py` → `serve()`，`--job-worker` 走 `worker.py`），
按行收发 JSON 请求/事件。**现在生产路径已完全不调用它**（Rust 侧不再有任何 Python 回退），
但 `audit_engine/handlers.py`（1600 行）是 `tauri-app/*_PARITY.md` 里反复引用的**业务金标**：
Rust 实现的字段映射、匹配、导出口径都是照着它对齐的。改 Rust 业务逻辑做等价性核对时读这里。

### 构建系统（旧）

`build_suite.py` + `suite.spec` 把 `tools.json`、`tools/`、`modules/` 打进单文件 exe，
`excludes` 大量科学计算库控体积；`launcher/bundle_anchor.touch_bundle_deps()` 用于让 PyInstaller
静态分析追踪 pandas/numpy/openpyxl/polars 等运行时依赖。
`build_suite.py` 顶部有硬编码 `LEGACY_PATHS`（`C:\Users\Administrator\Downloads\...`），只在 `tools/`、`modules/` 都缺该工具时才尝试。
这套构建只产出旧版 exe，与 `tauri-app/dist/` 的发布物无关。

### LLM 辅助模块（Python 侧，Rust 已重写）

配置在 `%APPDATA%/AuditToolbox/llm_settings.json`（生产栈已改为 SQLite + Windows 凭据管理器）。
三个模块都是纯 `urllib.request` 调用 OpenAI 兼容 API，不依赖 openai SDK：

- **`launcher/llm_client.py`**（~3150 行）：FA List 字段映射建议、字段复核、匹配键复核、看账映射检测、合并调用、连接测试。
  两个值得保留的设计——**盲评机制**（先把列名替换成匿名 ID，让模型仅凭数据形态判断字段角色，再与脚本映射比对，避免被列名误导）；
  **匹配键禁列过滤**（折旧/原值/类别/日期等会变动的业务字段不能当匹配键）。
- **`launcher/llm_analysis.py`**（~1180 行）：给导出 Excel 追加"LLM分析"Sheet。
  **规则化优先 + LLM 兜底**——pandas 先算出结构化候选数据，LLM 只负责把它写成自然语言；
  LLM 不可用时规则化回退仍能独立产出可用文本。原始数据不出本机。
- **`launcher/llm_settings.py`**：设置弹窗与 JSON 持久化。

## 关键约定

### 旧子工具入口签名

推荐 `main(root=None)`：`root is None` 时自建 `tk.Tk()` 并 `mainloop()`；嵌入模式下**不要**
`mainloop()` / `transient()` / `overrideredirect()` / 在传入 root 上 `grab_set()` / 调 `SetProcessDpiAwareness()`
——这些都会破坏 runner 准备好的 Toplevel 或卡死 Hub。`main(parent=None)` 旧签名仍兼容但不要再用。

### 接入/调试旧工具的实战经验

1. **入口文件名优先 ASCII**：`tools.json` 的 `entry` 指向 `main.py`；实际脚本叫 `看账小工具+4.0.py` 这种就包一层转发
2. **包装入口要把动态加载的模块注册进 `sys.modules`**：否则 `@dataclass` 运行时回查模块对象会报 `NoneType has no attribute '__dict__'`
3. **要切换工具来源改 `tools.json`**，别只改 `tools/xxx/`——查找顺序 `vendor/` 优先
4. **控制台输出避开 `✅`/`❌` 等非 ASCII**：Windows GBK 控制台会 `UnicodeEncodeError`（这条对 Rust/Node 脚本同样适用）

### 两栈同步

- 改工具清单要同时看 `tools.json`（旧栈注册表）和 `tauri-app/public/tool-catalog.json`（生产清单），后者是生产唯一来源
- 生产行为的等价性结论写在 `tauri-app/*_PARITY.md`，不要在这里重复维护

## 测试

`tests/` 下约 20 个文件，unittest 风格但可用 pytest 跑，覆盖 LLM 客户端（FA 复核 / 看账映射 / Dify）、
FA List 导出器口径（匹配键日期、汇总噪声、未分类异常、模板计算字段等）、
以及四个直接针对 Tauri 迁移的对照文件——`test_tauri_engine.py`、`test_fa_tauri_export.py`、
`test_confirmation_tauri.py`、`test_roll_forward_tauri.py`（走 `audit_engine` 协议，产出 Rust 侧要对齐的金标）。

这套测试是 `tauri-app/scripts/build_tauri_release.py --legacy-regression` 的一部分，默认打包流程不跑；
改 `audit_engine/handlers.py` 或 `tools/fa_list/` 的业务口径时应主动跑一遍。
tkinter GUI 没有自动化测试。
