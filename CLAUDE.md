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


## 关键约定

### 接入/调试旧工具的实战经验

1. **入口文件名优先 ASCII**：`tools.json` 的 `entry` 指向 `main.py`；实际脚本叫 `看账小工具+4.0.py` 这种就包一层转发
2. **包装入口要把动态加载的模块注册进 `sys.modules`**：否则 `@dataclass` 运行时回查模块对象会报 `NoneType has no attribute '__dict__'`
3. **要切换工具来源改 `tools.json`**，别只改 `tools/xxx/`——查找顺序 `vendor/` 优先
4. **控制台输出避开 `✅`/`❌` 等非 ASCII**：Windows GBK 控制台会 `UnicodeEncodeError`（这条对 Rust/Node 脚本同样适用）

### 两栈同步

- 改工具清单要同时看 `tools.json`（旧栈注册表）和 `tauri-app/public/tool-catalog.json`（生产清单），后者是生产唯一来源
- 生产行为的等价性结论写在 `tauri-app/*_PARITY.md`，不要在这里重复维护

### 优先修改或通过公共引擎实现修复或迭代
- 如果涉及bug或影响较广的功能修复、迭代，请优先修改或维护影响多数工具的公共代码，譬如TBJE的公共引擎，而非仅仅对当前子工具进行维护；

## 测试

`tests/` 下约 20 个文件，unittest 风格但可用 pytest 跑，覆盖 LLM 客户端（FA 复核 / 看账映射 / Dify）、
FA List 导出器口径（匹配键日期、汇总噪声、未分类异常、模板计算字段等）、
以及四个直接针对 Tauri 迁移的对照文件——`test_tauri_engine.py`、`test_fa_tauri_export.py`、
`test_confirmation_tauri.py`、`test_roll_forward_tauri.py`（走 `audit_engine` 协议，产出 Rust 侧要对齐的金标）。

这套测试是 `tauri-app/scripts/build_tauri_release.py --legacy-regression` 的一部分，默认打包流程不跑；
改 `audit_engine/handlers.py` 或 `tools/fa_list/` 的业务口径时应主动跑一遍。
tkinter GUI 没有自动化测试。
