# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目定位

`tauri-app/` 是审计工具箱 2.x 的完整独立工程：Tauri 2 + React 19/TypeScript 前端 + **全 Rust 原生业务核心**。
它取代上一级目录的 tkinter Hub（`launcher/`、`suite_main.py`）与 Python 引擎（`audit_engine/`）——
后者仅作为迁移金标保留，**不参与运行，也不进入发布 EXE**。

九个工具全部走 Rust 生产路由，详见 [TAURI_MIGRATION.md](TAURI_MIGRATION.md) 与 [RUST_PRODUCTION_CUTOVER.md](RUST_PRODUCTION_CUTOVER.md)。

## 常用命令

在 `tauri-app/` 目录下执行：

```bash
npm install                 # 首次
npm run tauri:dev           # 开发模式（需要 MSVC 环境；推荐用下面的 bat/脚本）
npm run build               # 仅前端类型检查 + Vite 构建 -> dist-web/
npm test                    # 前端测试（vitest + jsdom）
npx vitest run src/faListUi.test.ts    # 单个前端测试文件
cargo test --manifest-path src-tauri/Cargo.toml                 # Rust 全量测试
cargo test --manifest-path src-tauri/Cargo.toml fa::            # 单个模块的 Rust 测试
```

Excel COM 相关测试默认 ignored，需显式跑：

```bash
cargo test --manifest-path src-tauri/Cargo.toml excel_com_preserves_formula_and_sheet_order -- --ignored
```

开发启动与打包优先用脚本（它们会用 `vswhere` 注入 MSVC 环境变量，直接跑 `npm run tauri:dev` 往往因缺少 C++ 工具链失败）：

```bash
python scripts/start_tauri_dev.py
```

```bash
python scripts/build_tauri_release.py
```

对应的双击入口是 `启动审计工具箱.bat` 和 `打包Tauri审计工具箱.bat`（`打包审计工具箱.bat` 等价）。
`--skip-tests` 跳过测试、`--smoke-only` 只对现有 EXE 跑冷启动验收、`--reuse-dependencies` 复用现有 `node_modules`、
`--legacy-regression` 额外跑上一级的 Python/AudiPick 旧金标（默认不跑）。

## 架构

### 调用链

```
React 页面 → src/api.ts → Tauri invoke → src-tauri/src/lib.rs（命令白名单）→ 各业务 .rs
```

`lib.rs` 只暴露 15 个 `#[tauri::command]`，其中两个是业务入口：

- **`engine_call(method, params)`** —— 短任务/校验类，按 method 前缀分发到 `audipick` / `fa` / `confirmation` /
  `wp` / `file_list` / `excel_merger` / `tabular`（`ts.*` + `kanzhang.*`）/ `roll_forward`，在 `spawn_blocking` 内同步执行并直接返回结果。
- **`job_start(method, params)`** —— 耗时任务，返回 `jobId`，通过 `job-event` 事件流推进度。

**未知方法必须报错，不允许静默回退**：`engine_call` 返回 `METHOD_NOT_FOUND`，`job_start` 同理，
`job_cancel` / `job_pause` 对未知任务返回 `JOB_NOT_FOUND`。新增业务方法要同时在 `lib.rs` 的分发分支和
`excel_merger::is_supported_job_method` 里显式登记。

### 耗时任务 = 同一个 EXE 重入为独立 worker 进程

`ExcelMergerService`（`excel_merger.rs`，名字是历史遗留，实际是所有重任务的统一调度器）：

1. `start()` 生成 `jobId`，在 `%TEMP%\AuditToolbox\rust-job-cancel\` 下约定 `<jobId>.cancel` / `<jobId>.pause` 标记文件；
2. 用 `std::env::current_exe()` 重新拉起自己，附加 `--rust-table-worker`（或 `--excel-merger-worker`）；
   `main.rs` 检测到该参数就走 `worker_main()` 而不是启动窗口；
3. 父子进程之间：**stdin 一行 JSON 请求**（`WorkerRequest`），**stdout 逐行 JSON 事件**；父进程把事件原样 `emit("job-event")` 给前端；
4. 取消/暂停靠文件标记协作实现——worker 内的 `PauseCheckpoint::wait()` 放在各安全阶段之间，取消返回 `JOB_CANCELLED`。

好处是崩溃隔离与真正的可取消；代价是 **worker 里不能用 Tauri state**，所需的设置必须由 `lib.rs` 提前注入进 params。

### 设置与密钥注入

FA 与 Roll Forward 的 LLM 参数不是前端传的，而是 `lib.rs` 在分发前从 `Storage` + Windows 凭据管理器读出来，
注入 `params.__settings` / `params.__llmOptions`（见 `inject_fa_settings` / `inject_roll_forward_llm`）。
`secret_set` 只接受 `llm_api_key` / `dify_api_key` / `baidu_ocr_key` / `baidu_ocr_secret` 四个名字，其余拒绝。

### 文件系统安全边界

Tauri capability 只给了 `core:default`（`src-tauri/capabilities/main.json`），前端**没有任何直接文件权限**。
所有路径都经 `AllowedPaths` 白名单：`pick_path` 弹系统对话框后把用户选中的路径记入白名单，
任务产出的路径也会记入；`open_output` 只允许打开白名单内的路径。
`path_is_permitted` 的语义务必保留：**选中目录授权其后代，选中/生成的文件只授权该文件本身，绝不反向授权其祖先目录**
（否则一个 `C:\x\y.xlsx` 会授权 `C:\`）——`lib.rs` 里有专门的回归测试。

### 前端结构

- `public/tool-catalog.json` 是九个工具的唯一清单。它既被 `tool_catalog` 命令 `include_str!` 嵌入 EXE，
  也被浏览器预览模式 `fetch` 读取。改工具列表只改这一个文件；Rust 侧有"必须是 9 个且 id 唯一"的测试。
- `src/toolDefinitions.ts` 用声明式的 `fields` + `actions` 驱动通用 `ToolPage`（表单 + 调用 `call`/`job`）。
  简单工具只需在这里加一条定义。
- 复杂工具有专用页面：`TsManagerParityPage` / `KanzhangParityPage` / `ConfirmationProgressPage` /
  `FileListDirectoryPage` 是独立文件；**FA List 和 AudiPick 的完整交互写在 `App.tsx` 里**（该文件 5600+ 行，
  同时包含 `Dashboard`、`ToolPage`、`TaskCenter`、`History`、`Settings` 路由）。
- `src/api.ts` 的 `inTauri()` 降级：`npm run dev` 直接开浏览器时只能看 UI，任何本地文件操作都会抛"预览模式"错误。
- 所有跨边界数据用 zod 校验（`src/types.ts`）；Rust 侧 `AppError` 序列化为 camelCase
  （`code` / `userMessage` / `retryable` / `diagnosticId`），前端按这个契约展示错误。

### 数据与内嵌资源

- 本机数据目录：`%LOCALAPPDATA%\AuditToolbox\AuditToolbox\data`，SQLite 表 `settings`、`migrations`、
  `task_history`、`audipick_projects`、`audipick_documents`（`storage.rs`）。
- 编译期内嵌：`assets/roll-forward/subjects_config.json`、`assets/wp/FY27+WP服务单.xlsx.b64`（模板以 base64 文本内嵌）、
  `public/tool-catalog.json`。改这些文件必须重新编译 Rust 才生效。
- `assets/audipick/{rules,pdfjs}` 由 `vite.config.ts` 的自定义插件在 dev 时以中间件提供、build 时拷进 `dist-web/`。
- TS / 看账走 Polars，并在缓存目录写**稳定 Parquet 缓存**（缓存键含源文件规范路径、大小、修改时间）；
  缓存损坏时直接删除重读，不能让坏缓存阻塞用户。

## 关键约定

### 版本号有四处，必须同步

`package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`、`scripts/build_tauri_release.py` 顶部的 `VERSION`。
发布产物名 `dist/审计工具箱-v<VERSION>-win-x64.exe` 由脚本里的 `VERSION` 决定，不一致会导致验收找不到文件。

### 打包必须走 Tauri CLI

只能用 `npm run tauri:build`（`--no-bundle`，输出单文件 EXE）。
直接 `cargo build --release` 出来的 EXE 会把 WebView 指向 `devUrl`（localhost:1420），脱离开发机就是白屏。
发布脚本**不会覆盖已有的 dist EXE**，每个版本单独产出并附 `.sha256`。

### 发布门禁（`build_tauri_release.py`）

构建后会用发布 EXE 自身的 worker 入口做冷启动验收：Excel Merger、TS、看账、FA、WP、Roll Forward
（样例在 `tests/fixtures/`），再对桌面进程做两条反向断言——**没有 `audit-engine.exe` 子进程**、
**没有新增 Python runtime 文件**。改动业务模块时要保证这些 worker 路径仍能跑通，否则打包直接失败。

### `*_PARITY.md` 是迁移验收矩阵

九个工具各有一份，逐条记录"旧 Python 模块 → Rust 行为 → 对应测试"，
并明确标注哪些结论只有合成样例、仍需真实脱敏样例验收：
`FA_RUST_PARITY.md`、`ROLL_FORWARD_RUST_PARITY.md`、`WP_RUST_PARITY.md`、`KANZHANG_PARITY.md`、
`TS_PARITY.md`、`CONFIRMATION_PROGRESS_PARITY.md`、`FILE_LIST_DIRECTORY_PARITY.md`、
`EXCEL_MERGER_PARITY.md`、`AUDIPICK_PARITY.md`（后两份 2026-08-05 才补建，此前这两个工具从未做过系统核对）。

改动对应的 Rust 业务逻辑时同步更新这些矩阵，**不要把合成回归通过写成"与旧版完全等价"**。

两条从教训里来的写法约定：

- **不要在文档里写死测试数量**。此前 FA/Roll Forward/WP 三份记录的数字全部与实际对不上——
  每加一个测试就过期一次。写运行命令，不写数字。
- **不要把"已实现"写成"已保留全部行为"**。函证那份曾写"保留合并表头、色值、边框、数据条"，
  实际斑马纹、行高、对齐、字号都没保留，数据条也只保留了颜色没保留刻度。
  拿不准就逐项列"保留了什么 / 没保留什么"。

### 其他

- 面向用户的文案（错误信息、进度提示、Sheet 名）一律中文；Windows GBK 控制台下避免 `✅`/`❌` 等字符。
- 目标平台只有 Windows x64；`webview2_available()`、Excel COM、凭据管理器都是 Windows 专用路径。
- 上一级目录的 `tests/`（`test_tauri_engine.py`、`test_fa_tauri_export.py` 等）是 Python 金标，
  只在 `--legacy-regression` 时运行，不是本工程的常规测试。
