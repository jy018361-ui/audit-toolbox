# 审计工具箱

一个面向审计、财务和数据处理场景的 Windows 桌面工具箱。项目基于 Python + Tkinter，采用 Hub 启动器统一承载多个子工具，重点服务固定资产匹配、凭证查看、Excel 合并、函证进度整理、文件目录清单等高频工作。

## 主要功能

- **FA List 匹配工具**：固定资产底稿双表匹配、字段配置、透视汇总、异常检查和导出。
- **看账小工具**：凭证导入、科目筛选、数据查看、导出和辅助映射。
- **Excel 批量合并**：批量读取工作簿和工作表，合并输出并在异常场景给出可见提示。
- **函证进度工具**：整理函证流程中的清单、进度和导出结果。
- **文件目录工具**：生成目录清单、超链接和辅助检查结果。
- **统一 Hub**：通过一个入口启动各子工具，尽量保持一致的窗口布局、状态反馈和错误提示。
- **LLM 辅助能力**：可选配置 OpenAI 兼容接口，用于字段映射建议、映射复核和导出结果分析。

## 环境要求

- Windows 10/11
- Python 3.10+

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
