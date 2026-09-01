# AGENTS.md

审计工具箱 2.x 的完整独立工程：Tauri 2 + React 19/TypeScript 前端 + **全 Rust 原生业务核心**，
仅面向 Windows x64。上一级目录的 tkinter/Python 引擎（`launcher/`、`audit_engine/`）只是迁移金标，
不参与运行、不进发布 EXE。更详细的背景见 [CLAUDE.md](CLAUDE.md)（个别数字已过期，以本文件为准）。

## 常用命令

在 `tauri-app/` 目录下执行（包管理用 npm，勿混用 pnpm 安装）：

```bash
npm install                                          # 首次
npm run build                                        # 前端类型检查 (tsc -b) + Vite 构建 -> dist-web/
npm test                                             # 前端测试 (vitest + jsdom)
npx vitest run src/faListUi.test.ts                  # 单个前端测试文件
cargo test --manifest-path src-tauri/Cargo.toml      # Rust 全量测试
cargo test --manifest-path src-tauri/Cargo.toml fa:: # 单个模块的 Rust 测试
```

Excel COM 相关测试默认 ignored，需加 `-- --ignored` 显式运行。

开发/打包优先用脚本（用 vswhere 注入 MSVC 环境，直接 `npm run tauri:dev` 常因缺 C++ 工具链失败）：

```bash
python scripts/start_tauri_dev.py      # 开发模式
python scripts/build_tauri_release.py  # 发布打包（--skip-tests / --smoke-only / --legacy-regression 可选）
```

## 架构

调用链：`React 页面 → src/api.ts → Tauri invoke → src-tauri/src/lib.rs（命令白名单）→ 各业务 .rs`。

- `lib.rs` 暴露约 19 个命令，业务入口两个：**`engine_call(method, params)`**（短任务，同步返回）和
  **`job_start(method, params)`**（耗时任务，返回 jobId，经 `job-event` 事件流推进度）。
- **未知方法必须报错**（`METHOD_NOT_FOUND` / `JOB_NOT_FOUND`），不允许静默回退。
  新增 job 方法要**同时**登记 `excel_merger::SUPPORTED_JOB_METHODS` 和 `lib.rs` 的 `is_direct_job_method`
  ——只登记一处会导致前端报「未找到对应的 Rust 任务方法」，lib.rs 里有专门回归测试盯这一点。
- 耗时任务 = 同一个 EXE 以 `--rust-table-worker` / `--excel-merger-worker` 参数重入为独立 worker 进程：
  stdin 一行 JSON 请求、stdout 逐行 JSON 事件；取消/暂停靠 `%TEMP%\AuditToolbox\rust-job-cancel\` 下的
  标记文件协作。**worker 里不能用 Tauri state**，所需设置必须由 `lib.rs` 提前注入 params
  （`__settings` / `__llmOptions`，来自 SQLite Storage + Windows 凭据管理器）。
- `secret_set` 只接受 `llm_api_key` / `dify_api_key` / `baidu_ocr_key` / `baidu_ocr_secret` 四个名字。

### 文件系统安全边界

Tauri capability 只有 `core:default`，前端无任何直接文件权限。所有路径经 `AllowedPaths` 白名单：
`pick_path` 把用户选中路径记入白名单，`open_output` 只开白名单内路径。
`path_is_permitted` 语义：**选中目录授权后代；选中文件只授权该文件本身，绝不反向授权祖先目录**（有回归测试）。

### 前端结构

- `public/tool-catalog.json` 是 18 个工具的唯一清单（`include_str!` 嵌入 EXE，浏览器预览模式 fetch 读取）。
  改工具列表只改这一个文件；Rust 测试断言 18 个且 id 唯一。
- 简单工具在 `src/toolDefinitions.ts` 加声明式定义（fields + actions 驱动通用 ToolPage）；
  复杂工具有专用 `*Page.tsx`；AudiPick / FA List 的完整交互仍在 `App.tsx`（5000+ 行，含全部路由）。
- `src/api.ts` 的 `inTauri()` 降级：浏览器直接开 `npm run dev` 只能看 UI，本地文件操作抛"预览模式"错误。
- 跨边界数据用 zod 校验（`src/types.ts`）；Rust 侧 `AppError` 序列化为 camelCase
  （`code` / `userMessage` / `retryable` / `diagnosticId`），前端按此契约展示错误。
- 页面级样式用同名单独 CSS 文件（如 `fx-audit.css`、`tbje-check.css`）+ Tailwind 4 / shadcn 组件。

### 数据与内嵌资源

- 本机数据目录 `%LOCALAPPDATA%\AuditToolbox\AuditToolbox\data`（SQLite：settings / migrations / task_history /
  audipick_projects 等，见 `storage.rs`）。
- 编译期内嵌（改动必须重编 Rust）：`assets/roll-forward/subjects_config.json`、`assets/wp/FY27+WP服务单.xlsx.b64`、
  `public/tool-catalog.json`。
- TS / 看账走 Polars，缓存目录写稳定 Parquet 缓存（键含规范路径+大小+mtime）；缓存损坏直接删了重读。

## 版本与发布

- 版本号**四处必须同步**：`package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`、
  `scripts/build_tauri_release.py` 顶部 `VERSION`。产物名 `dist/审计工具箱-v<VERSION>-win-x64.exe` 由脚本 VERSION 决定。
- 分发只能走 Tauri CLI（`npm run tauri:build` / 发布脚本）。直接 `cargo build --release` 的 EXE 会指向
  localhost:1420，离开开发机白屏。发布脚本不覆盖已有 dist EXE，每版本单独产出并附 `.sha256`。
- 发布门禁：构建后用发布 EXE 的 worker 入口做冷启动验收（样例在 `tests/fixtures/`），并断言无
  `audit-engine.exe` 子进程、无新增 Python runtime。改业务模块要保证 worker 路径可跑通，否则打包失败。

## 文档约定（改代码前先读，改完同步）

- `*_PARITY.md`（FA / ROLL_FORWARD / WP / KANZHANG / TS / CONFIRMATION / FILE_LIST / EXCEL_MERGER / AUDIPICK）
  是"旧 Python → Rust 行为 → 对应测试"的迁移验收矩阵。改对应 Rust 逻辑时同步更新；
  **不要写死测试数量**（写运行命令），**不要把"已实现"写成"已保留全部行为"**——逐项列保留/未保留。
- 账表映射/勾稽公共引擎（`ledger_mapping.rs`、`tbje_check.rs`、`fa_tbje.rs`）动前必读
  [LEDGER_MAPPING_UNIFICATION.md](LEDGER_MAPPING_UNIFICATION.md) 与 [TBJE_CHECK.md](TBJE_CHECK.md)。
- 界面改动按 [UI_CHANGELOG.md](UI_CHANGELOG.md) 顶部的模板在文件顶部追加记录（含日期、目标、设计决策）。

## 其他约定

- 面向用户的文案（错误、进度、Sheet 名）一律中文；Windows GBK 控制台输出避免 `✅`/`❌` 等字符。
- 提交信息为中文 conventional 风格：`fix(tbje): ...`、`feat(账表核对): ...`、`chore(release): 版本号升至 ...`；
  发版提交在 message 里注明 alpha 版本号。
- `webview2_available()`、Excel COM、凭据管理器均为 Windows 专用路径，不做跨平台兼容。
- 上一级目录的 Python 测试（`test_tauri_engine.py` 等）是金标，仅 `--legacy-regression` 时运行，不是常规测试。
