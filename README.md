# E点通工具箱（审计工具箱）

一个面向审计、财务和数据处理场景的 Windows 桌面工具箱。2.x 基于 **Tauri 2 + React 19/TypeScript 前端 + 全 Rust 原生业务核心**，九个工具全部由 Rust 执行生产逻辑，发布为单个 EXE。

> **给各工具负责人**：本 README 说明 Tauri 架构下代码在哪里、日常怎么改、怎么验证、怎么打包发布。只使用工具的人下载发布版 EXE 即可，无需关心工程。
> 完整迁移验收矩阵见 `tauri-app/*_PARITY.md`，架构细节见 `tauri-app/CLAUDE.md`。

## 功能一览

- **FA List 匹配工具**（`fa_list`）：固定资产底稿双表匹配、字段配置、透视汇总、异常检查和导出。
- **看账小工具**（`kanzhang`）：凭证读取、字段映射、目标科目扩展、净额汇总、损益结转、JE 两轮匹配、工作簿导出。
- **TS 管理**（`ts_manager`）：筛选、默认双 Sheet 透视、稳定 Parquet 缓存、可选明细 CSV。
- **函证进度小工具**（`confirmation_progress`）：整理函证流程中的清单、进度和导出结果。
- **Excel 批量合并**（`Excel_Merger`）：Rust 直接扫描、读取并写出 XLSX/XLS/XLSM/CSV/TXT；多 Sheet 模式通过 Excel 原生接口保留公式、格式、图片。
- **文件目录清单**（`file_list_directory`）：生成目录清单、超链接和辅助检查结果。
- **AudiPick 智能合同审阅**（`audipick`）：合同 OCR、条款提取、PDF 定位预览、收入合同审阅底稿生成。
- **Audit Roll Forward**（`audit_roll_forward`）：结转公司标准 V6 审计底稿，迁移期初、公式、审计措辞及 CRA 信息。
- **FY27 WP 服务单生成**（`wp_service_generator`）：拆分 AUD/IPO 与 archive，生成 Section 服务方案及 SER 测算。
- **统一 Hub**：一个入口启动各子工具，统一的侧边栏导航、状态反馈、错误提示和任务中心。
- **LLM 辅助能力**：可选配置 OpenAI 兼容接口，用于字段映射建议、映射复核和导出结果分析。

## Tauri 架构速览

```
React 页面 → src/api.ts → Tauri invoke → src-tauri/src/lib.rs（命令白名单）→ 各业务模块（.rs）
```

- **前端**（`tauri-app/src/`）：React + TypeScript 界面，负责表单、预览、进度展示。
- **后端**（`tauri-app/src-tauri/src/`）：Rust 业务核心，负责所有文件读取、Excel/CSV 处理、计算与导出。
- **耗时任务**：同一个 EXE 以 worker 进程方式重新拉起自身（`--rust-table-worker` 等），通过 `job-event` 事件流向前端推进度，支持取消/暂停。
- **浏览器预览模式**：`npm run dev` 直接开浏览器只能看 UI，任何本地文件操作都会提示"预览模式"错误——文件能力必须在 Tauri 里才可用。

## 代码地图：九个工具在哪里

所有生产代码都在 **`tauri-app/`** 目录下。工具清单唯一来源是 `tauri-app/public/tool-catalog.json`。

| 工具 | 前端页面 | Rust 业务 |
|---|---|---|
| FA List（`fa_list`） | [tauri-app/src/FaListPage.tsx](tauri-app/src/FaListPage.tsx) · [tauri-app/src/faListUi.ts](tauri-app/src/faListUi.ts) | [tauri-app/src-tauri/src/fa.rs](tauri-app/src-tauri/src/fa.rs) |
| 看账（`kanzhang`） | [tauri-app/src/KanzhangParityPage.tsx](tauri-app/src/KanzhangParityPage.tsx) | [tauri-app/src-tauri/src/tabular.rs](tauri-app/src-tauri/src/tabular.rs)（`kanzhang.*` 方法） |
| TS 管理（`ts_manager`） | [tauri-app/src/TsManagerParityPage.tsx](tauri-app/src/TsManagerParityPage.tsx) | [tauri-app/src-tauri/src/tabular.rs](tauri-app/src-tauri/src/tabular.rs)（`ts.*` 方法） |
| 函证进度（`confirmation_progress`） | [tauri-app/src/ConfirmationProgressPage.tsx](tauri-app/src/ConfirmationProgressPage.tsx) | [tauri-app/src-tauri/src/confirmation.rs](tauri-app/src-tauri/src/confirmation.rs) |
| Excel 合并（`Excel_Merger`） | [tauri-app/src/ExcelMergerPage.tsx](tauri-app/src/ExcelMergerPage.tsx) | [tauri-app/src-tauri/src/excel_merger.rs](tauri-app/src-tauri/src/excel_merger.rs) |
| 文件目录（`file_list_directory`） | [tauri-app/src/FileListDirectoryPage.tsx](tauri-app/src/FileListDirectoryPage.tsx) · [tauri-app/src/fileListUi.ts](tauri-app/src/fileListUi.ts) | [tauri-app/src-tauri/src/file_list.rs](tauri-app/src-tauri/src/file_list.rs) |
| AudiPick（`audipick`） | [tauri-app/src/AudiPickPage.tsx](tauri-app/src/AudiPickPage.tsx) · [tauri-app/src/audipickUi.ts](tauri-app/src/audipickUi.ts) | [tauri-app/src-tauri/src/audipick.rs](tauri-app/src-tauri/src/audipick.rs) |
| Roll Forward（`audit_roll_forward`） | [tauri-app/src/RollForwardPage.tsx](tauri-app/src/RollForwardPage.tsx) · [tauri-app/src/rollForwardUi.ts](tauri-app/src/rollForwardUi.ts) | [tauri-app/src-tauri/src/roll_forward.rs](tauri-app/src-tauri/src/roll_forward.rs) |
| WP 服务单（`wp_service_generator`） | [tauri-app/src/toolDefinitions.ts](tauri-app/src/toolDefinitions.ts)（通用 ToolPage 驱动） | [tauri-app/src-tauri/src/wp.rs](tauri-app/src-tauri/src/wp.rs) |

> 表格里每个路径都是相对**仓库根**的完整路径，在 GitHub 上点击可直接打开对应文件。

- 简单工具（表单 + 按钮即可）可以在 `src/toolDefinitions.ts` 里用声明式 `fields` + `actions` 加一条定义，由通用 `ToolPage` 渲染，无需新建页面文件。
- 复杂交互的工具建独立页面（见上表），并优先复用 `src/components/` 里的公共组件：`FileDropInput`（拖放/点选上传）、`DataTable`（数据预览）、`StepIndicator`（步骤条）、`JobProgress`（任务进度）、`PageHeader`、`ResultCard` 等。
- 侧边栏分组在 `src/App.tsx`：**审计工具**（fa_list / kanzhang / audipick / audit_roll_forward）、**效率工具**（Excel_Merger / file_list_directory）、**运营工具**（ts_manager / confirmation_progress / wp_service_generator）。

## 开发环境

前置要求：

- Windows 10/11 x64，WebView2（Windows 11 自带）
- **Node.js 22**、**Rust stable-msvc**（rustup）、**Visual Studio C++ Build Tools**（MSVC 工具链）
- Python 3.10+：仅用于打包脚本和跑旧金标测试，不进入发布 EXE

首次准备与日常启动（都在 `tauri-app/` 目录下）：

```bash
npm install                                    # 首次安装依赖
python scripts/start_tauri_dev.py              # 启动开发版（推荐，自动注入 MSVC 环境）
# 或双击「启动审计工具箱.bat」
```

测试：

```bash
npm test                                       # 前端测试（vitest + jsdom）
npx vitest run src/faListUi.test.ts            # 单个前端测试文件
cargo test --manifest-path src-tauri/Cargo.toml                # Rust 全量测试
cargo test --manifest-path src-tauri/Cargo.toml fa::           # 单个模块
# Excel COM 相关测试默认忽略，需加 -- --ignored
```

## 日常维护：改一个工具要动哪些文件

1. **改界面布局、按钮、提示文字** → 改上表对应工具的前端页面（`src/...Page.tsx`）。
2. **改业务逻辑、文件解析、Excel 生成** → 改上表对应的 Rust 模块（`src-tauri/src/...rs`）。
3. **新增一个业务动作**（例如"增加一个导出按钮"）：
   - 前端：页面里加按钮，调用 `src/api.ts` 的 `call`/`job`（method 形如 `fa.someAction`）；
   - 后端：在 `src-tauri/src/lib.rs` 的 `engine_call` / `job_start` 分发分支里登记这个 method，并实现到对应 `.rs` 模块。**未知 method 必须报错，不允许静默忽略**。
4. **改动业务逻辑后**：同步更新对应 `*_PARITY.md`（如 `FA_RUST_PARITY.md`）中的验收结论，并在本地跑测试。

## 打包发布

一键打包（推荐，已修复可直接使用）：

```bash
# 在 tauri-app/ 目录下
python scripts/build_tauri_release.py --reuse-dependencies
# 或双击「打包Tauri审计工具箱.bat」
```

产物在 `tauri-app/dist/`：`E点通工具箱-v<VERSION>-win-x64.exe` 及同名 `.sha256`。脚本不会覆盖旧版 EXE，每个版本单独产出。

**版本号有四处，改版本时必须同步**：`package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`、`scripts/build_tauri_release.py` 顶部的 `VERSION`。

**发布门禁**：打包后脚本会用发布 EXE 自身的 worker 入口做冷启动验收（Excel 合并、TS、看账、FA、WP、Roll Forward），并断言**没有 Python 子进程、没有新增 Python runtime**。改业务模块时保证这些 worker 路径仍能跑通，否则打包直接失败。

## 维护者必读约定

- **前端没有任何直接文件权限**：Tauri capability 只开了 `core:default`，所有路径都经 `AllowedPaths` 白名单。让用户选文件用 `pick_path`（系统对话框），选中后才授权该路径。不要绕开白名单。
- **耗时任务 = worker 进程**：worker 里不能使用 Tauri state，所需的设置必须由 `lib.rs` 在分发前注入进 params（见 `inject_fa_settings` / `inject_roll_forward_llm`）。
- **面向用户的文案一律中文**（错误信息、进度提示、Sheet 名）。
- **打包必须走 Tauri CLI**（`npm run tauri:build`）。直接 `cargo build --release` 产出的 EXE 会把界面指向开发地址，脱离开发机就是白屏。
- **数据与内嵌资源**：本机数据在 `%LOCALAPPDATA%\AuditToolbox\AuditToolbox\data`（SQLite）。编译期内嵌的资源（如 `assets/wp/FY27+WP服务单.xlsx.b64` 模板）修改后必须重新编译 Rust 才生效。
- **LLM 密钥**：配置经 SQLite + Windows 凭据管理器保存，只保存在本机，不提交到 GitHub。`secret_set` 只接受 `llm_api_key` / `dify_api_key` / `baidu_ocr_key` / `baidu_ocr_secret` 四个名字。
- **UI 调整原则**：优先改善信息层级、状态反馈、错误提示、窗口伸缩和操作效率，不改变既有业务流程。

## 遗留的旧 Python 栈

仓库根目录的 `launcher/`、`tools/`、`modules/`、`audit_engine/`、`suite_main.py`、`build_suite.py` 是 Tauri 迁移前的 tkinter + Python 版本，**只保留作迁移金标与回归测试，不参与生产运行，也不进入发布 EXE**。维护生产代码时不要修改它们；只有做新旧行为对照时才读 `audit_engine/handlers.py` 等金标文件。

## License

MIT
