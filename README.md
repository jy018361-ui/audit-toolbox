# 审计工具箱代码区说明

新版 Tauri 2 + React + Rust 工程已完整集中到 [`tauri-app`](./tauri-app)。
启动、测试和打包请进入该目录，双击 `启动审计工具箱.bat` 或
`打包审计工具箱.bat`。

根目录其余 `launcher`、`tools`、`modules`、`audit_engine` 和 Python
入口文件保留为旧 Tkinter/Python 基线与金标对照，不再参与新版生产运行。

---

一个面向审计、财务和数据处理场景的 Windows 桌面工具箱。当前迁移分支提供 **Tauri 2 + React/TypeScript** 统一桌面入口，九个注册工具的生产 RPC 和独立任务 worker 均由 Rust 执行。Python 源码只保留为迁移金标和回归测试，不进入发布 EXE，也不在用户电脑上启动或释放运行时。

## Tauri 迁移版

- 日常测试：双击 `启动审计工具箱.bat`，直接启动 Tauri 开发版；首次会编译，之后通常更快。开发版可与已打开的发布版并行运行。
- 命令行开发启动：`npm run tauri:dev`
- 严格单文件构建：双击 `打包Tauri审计工具箱.bat`
- 输出：`dist/审计工具箱-v2.0.0-alpha.15-win-x64.exe` 及同名 `.sha256`
- 构建流程会依次执行 Python 金标、React、AudiPick 和 Rust 测试，验证 Excel COM 原样复制，随后执行九工具共用的 Rust worker 与单文件冷启动验收；冷启动会反向检查不存在 `audit-engine.exe` 和新 Python runtime。
- 迁移完成度与真实样例验收范围见 [TAURI_MIGRATION.md](TAURI_MIGRATION.md)。

## 主要功能

- **FA List 匹配工具**：固定资产底稿双表匹配、字段配置、透视汇总、异常检查和导出。
- **Excel 批量合并**：Rust 直接扫描、读取并纵向/横向写出 XLSX、XLS、XLSM、CSV、TXT；多 Sheet 模式通过 Microsoft Excel 原生接口保留公式、格式、图片和对象。
- **TS 管理**：Rust Polars 完成筛选、默认双 Sheet 透视、稳定 Parquet 缓存和可选明细 CSV。
- **看账小工具**：Rust Polars 完成凭证读取、字段映射、目标科目扩展、净额汇总、损益结转、JE 两轮匹配、宽松/严格凭证类型、多批次及工作簿导出。
- **函证进度工具**：整理函证流程中的清单、进度和导出结果。
- **文件目录工具**：生成目录清单、超链接和辅助检查结果。
- **AudiPick 智能合同审阅**：合同 OCR、条款提取、PDF 定位预览和收入合同审阅底稿生成。
- **Audit Roll Forward**：结转公司标准 V6 审计底稿，迁移期初、公式、审计措辞及 CRA 信息。
- **FY27 WP 服务单生成工具**：拆分 AUD、IPO 与 archive，生成 Section 服务方案及 SER 测算汇总。
- **统一 Hub**：通过一个入口启动各子工具，尽量保持一致的窗口布局、状态反馈和错误提示。
- **LLM 辅助能力**：可选配置 OpenAI 兼容接口，用于字段映射建议、映射复核和导出结果分析。

## 环境要求

- 运行发布版：Windows 10/11 x64、WebView2；仅多 Sheet 原样复制需要安装 Microsoft Excel。
- 从源码开发/打包：另需 Python 3.10+（仅运行历史金标测试与构建脚本）、Node.js、Rust stable-msvc 与 Visual Studio C++ Build Tools。

## 快速开始

安装依赖：

```bash
pip install -r requirements.txt
```

启动工具箱：

```bash
python suite_main.py
```

运行测试：

```bash
python -m unittest discover -s tests -p "test_*.py"
```

## LLM 辅助能力

Hub 顶部提供 **LLM 设置**入口。启用后，FA List 和看账工具可以调用 OpenAI 兼容 API 辅助完成字段映射建议、字段复核、匹配键复核和导出分析。

LLM 配置保存在当前 Windows 用户目录下：

```text
%APPDATA%\AuditToolbox\llm_settings.json
```

该配置文件只保存在本机，不提交到 GitHub。仓库中的代码只包含默认空配置和调用逻辑，不包含真实 API Key。

支持的常见配置项：

- `base_url`：OpenAI 兼容接口地址，例如 `https://api.openai.com/v1` 或其他兼容服务地址。
- `model`：模型名称。
- `api_key`：本机密钥，仅保存在用户 AppData 配置文件中。
- `timeout_seconds`：请求超时时间。

## 打包

完整构建：

```bash
python build_suite.py
```

仅同步打包用依赖目录：

```bash
python build_suite.py --sync-only
```

跳过基线对比：

```bash
python build_suite.py --no-baseline
```

打包输出位于 `dist/`。`vendor/`、`build/`、多数打包产物和本地验证产物不进入 Git。

Tauri 发布版中的 AudiPick 使用统一 React 界面和 Rust 内核，不需要单独放置 Electron 便携版。

## 项目结构

```text
audit-toolbox/
├── suite_main.py          # 工具箱主入口
├── tools.json             # 工具注册配置
├── build_suite.py         # 打包脚本
├── suite.spec             # PyInstaller 配置
├── requirements.txt       # Python 依赖
├── launcher/              # Hub、工具加载、主题和运行时辅助
├── tools/                 # 内置工具源码
├── modules/               # 可放置独立工具仓库或适配入口
├── tests/                 # 回归测试
└── dist/                  # 打包输出
```

## 开发说明

新增工具时，通常需要：

1. 将工具源码放入 `tools/` 或在 `modules/` 中接入独立工具目录。
2. 在 `tools.json` 中注册工具名称、入口文件和调用方式。
3. 确保入口提供 `main(parent=None)`，由 Hub 作为子窗口启动。
4. 对核心数据处理逻辑补充 `tests/` 下的回归测试。
5. 本地运行 `python suite_main.py` 和 `python -m unittest discover -s tests -p "test_*.py"` 验证。

本项目偏向稳定、克制、业务优先的桌面工具体验。UI 调整应优先改善信息层级、状态反馈、错误提示、窗口伸缩和操作效率，避免改变既有业务流程。

## Git 分支

- 默认分支：`main`
- 远端发布和网页展示以 `main` 为准。
- 如果需要保留 `master` 分支，请通过 Pull Request 或合并提交让 GitHub 知道 `master` 已合入 `main`。否则即使两个分支文件内容一致，GitHub 也可能因为提交关系不同显示 “recent pushes” 提示。

## 本地文件约定

以下内容不应提交到仓库：

- `scratchpad/`
- `verification_screenshots/`
- `__pycache__/`
- `.venv/` 或 `venv/`
- 临时日志、打包缓存和生成的中间文件

## 常见问题

### 打包后提示找不到模块

检查 `launcher/bundle_anchor.py`、`suite.spec` 的 hidden imports，以及对应工具是否已经同步到打包目录。

### 子工具能单独运行，但从 Hub 启动失败

确认入口文件存在 `main(parent=None)`，并且 `tools.json` 中的 `entry`、`vendor_dir`、`callable` 配置与实际目录一致。

### GitHub 显示 “Compare & pull request”

这通常是 GitHub 发现某个非默认分支最近被推送。它不一定代表文件内容不同。若要保留该分支并消除提示，应把该分支通过 PR 或合并提交并入 `main`。

## License

MIT
