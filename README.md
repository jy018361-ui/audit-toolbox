# E点通工具箱（审计工具箱）

一个面向审计、财务和数据处理场景的 Windows 桌面工具箱。2.x 基于 **Tauri 2 + React 19/TypeScript 前端 + 全 Rust 原生业务核心**，十七个工具全部由 Rust 执行生产逻辑，发布为单个 EXE。

> **给各工具负责人和贡献者**：本 README 是本项目的**唯一贡献规范入口**——代码在哪里、加东西要遵守什么、怎么验证、怎么打包发布，都在这里。只使用工具的人下载发布版 EXE 即可，无需关心工程。
> 各工具的迁移验收矩阵见 `tauri-app/*_PARITY.md`，架构细节见 `tauri-app/CLAUDE.md`，账表映射内核方案见 `tauri-app/LEDGER_MAPPING_UNIFICATION.md`。

## 功能一览

工具清单的唯一来源是 `tauri-app/public/tool-catalog.json`，侧边栏分三组：

**审计工具**

- **汇兑损益测算**（`fx_audit`）：已实现与未实现汇兑损益重算、央行汇率及 TB 勾稽。
- **存款利息收入测算**（`deposit_interest`）：识别货币资金科目，按序时账还原逐月余额，以月均余额×存款利率重算利息并与 TB 利息收入勾稽。
- **借款利息测算**（`loan_interest`）：借款台账直接重算，或以 TB＋JE 还原本金变动并补充固定/浮动利率。
- **FA 底稿生成**（可折叠子组）：**FA List 匹配工具**（`fa_list`，双表匹配、透视与导出）、**折旧测算**（`fa_dep_calc`）、**折旧政策对比**（`fa_policy_compare`，含税法最低折旧年限参考）。
- **看账工具**（可折叠子组）：**看账**（`kanzhang`，凭证导入、科目筛选、透视与导出）、**正负数凭证标记**（`je_sign_mark`，按批次标记目标科目的计提与冲销对冲）。
- **AudiPick 智能合同审阅**（`audipick`）：合同 OCR、条款提取、PDF 定位与收入底稿。
- **WP Roll Forward**（`audit_roll_forward`）：标准审计底稿跨年度结转与 CRA 信息迁移。
- **两列模糊匹配**（`fuzzy_match`）：公司名称/人名/地址/通用文本的模糊匹配核对，支持人工确认与底稿导出。

**效率工具**

- **Excel 批量合并**（`Excel_Merger`）：文件/文件夹队列、纵横合并、多 Sheet 工作簿与格式保留。
- **文件夹超链接清单**（`file_list_directory`）：导出分层目录与可点击文件超链接。
- **PDF 转 Excel**（`pdf_to_excel`）：文字版回函逐行转 Excel、表格自动提取、支持批量处理。

**运营工具**

- **TS 管理**（`ts_manager`）：工时扫描、筛选、透视与导出。
- **函证进度小能手**（`confirmation_progress`）：银行及往来函证统计、汇总与报告生成。
- **FY27 WP 服务单生成**（`wp_service_generator`）：拆分服务单并生成服务方案与工时核对。

**公共能力**

- **统一 Hub**：一个入口启动各子工具，统一的侧边栏导航、状态反馈、错误提示和工具内任务进度。
- **统一账表引擎**：TB / JE 的表头识别、角色映射、形态判定、借贷方向与 LLM 复核共用一套内核（见下方「涉及 TB / JE 的功能」）。
- **LLM 辅助能力**：可选配置 OpenAI 兼容接口，用于字段映射建议、映射复核和导出结果分析。

## Tauri 架构速览

```
React 页面 → src/api.ts → Tauri invoke → src-tauri/src/lib.rs（命令白名单）→ 各业务模块（.rs）
```

- **前端**（`tauri-app/src/`）：React + TypeScript 界面，负责表单、预览、进度展示。
- **后端**（`tauri-app/src-tauri/src/`）：Rust 业务核心，负责所有文件读取、Excel/CSV 处理、计算与导出。
- **耗时任务**：同一个 EXE 以 worker 进程方式重新拉起自身（`--rust-table-worker` 等），通过 `job-event` 事件流向前端推进度，支持取消/暂停。
- **浏览器预览模式**：`npm run dev` 直接开浏览器只能看 UI，任何本地文件操作都会提示"预览模式"错误——文件能力必须在 Tauri 里才可用。

## 代码地图：十七个工具在哪里

所有生产代码都在 **`tauri-app/`** 目录下。

| 工具 | 前端页面 | Rust 业务 |
|---|---|---|
| 汇兑损益（`fx_audit`） | [tauri-app/src/FxAuditPage.tsx](tauri-app/src/FxAuditPage.tsx) | [tauri-app/src-tauri/src/fx.rs](tauri-app/src-tauri/src/fx.rs) |
| 存款利息（`deposit_interest`） | [tauri-app/src/DepositInterestPage.tsx](tauri-app/src/DepositInterestPage.tsx) | [tauri-app/src-tauri/src/deposit_interest.rs](tauri-app/src-tauri/src/deposit_interest.rs) |
| 借款利息（`loan_interest`） | [tauri-app/src/LoanInterestPage.tsx](tauri-app/src/LoanInterestPage.tsx) | [tauri-app/src-tauri/src/loan_interest.rs](tauri-app/src-tauri/src/loan_interest.rs) |
| FA List（`fa_list`） | [tauri-app/src/FaListPage.tsx](tauri-app/src/FaListPage.tsx) · [tauri-app/src/faListUi.ts](tauri-app/src/faListUi.ts) | [tauri-app/src-tauri/src/fa.rs](tauri-app/src-tauri/src/fa.rs) |
| 折旧测算（`fa_dep_calc`） | [tauri-app/src/FaDepCalcPage.tsx](tauri-app/src/FaDepCalcPage.tsx) · [tauri-app/src/faSubtoolsUi.ts](tauri-app/src/faSubtoolsUi.ts) | [tauri-app/src-tauri/src/fa_subtools.rs](tauri-app/src-tauri/src/fa_subtools.rs)（`fa.dep_*` 方法） |
| 折旧政策对比（`fa_policy_compare`） | [tauri-app/src/FaPolicyComparePage.tsx](tauri-app/src/FaPolicyComparePage.tsx) · [tauri-app/src/faSubtoolsUi.ts](tauri-app/src/faSubtoolsUi.ts) | [tauri-app/src-tauri/src/fa_subtools.rs](tauri-app/src-tauri/src/fa_subtools.rs)（`fa.policy_*` 方法） |
| 看账（`kanzhang`） | [tauri-app/src/KanzhangParityPage.tsx](tauri-app/src/KanzhangParityPage.tsx) | [tauri-app/src-tauri/src/tabular.rs](tauri-app/src-tauri/src/tabular.rs)（`kanzhang.*` 方法） |
| 正负数标记（`je_sign_mark`） | [tauri-app/src/JeSignMarkPage.tsx](tauri-app/src/JeSignMarkPage.tsx) · [tauri-app/src/jeSignMarkUi.ts](tauri-app/src/jeSignMarkUi.ts) | [tauri-app/src-tauri/src/tabular.rs](tauri-app/src-tauri/src/tabular.rs)（`kanzhang.mark_*` 方法） |
| TS 管理（`ts_manager`） | [tauri-app/src/TsManagerParityPage.tsx](tauri-app/src/TsManagerParityPage.tsx) | [tauri-app/src-tauri/src/tabular.rs](tauri-app/src-tauri/src/tabular.rs)（`ts.*` 方法） |
| 函证进度（`confirmation_progress`） | [tauri-app/src/ConfirmationProgressPage.tsx](tauri-app/src/ConfirmationProgressPage.tsx) | [tauri-app/src-tauri/src/confirmation.rs](tauri-app/src-tauri/src/confirmation.rs) |
| Excel 合并（`Excel_Merger`） | [tauri-app/src/ExcelMergerPage.tsx](tauri-app/src/ExcelMergerPage.tsx) | [tauri-app/src-tauri/src/excel_merger.rs](tauri-app/src-tauri/src/excel_merger.rs) |
| 文件目录（`file_list_directory`） | [tauri-app/src/FileListDirectoryPage.tsx](tauri-app/src/FileListDirectoryPage.tsx) · [tauri-app/src/fileListUi.ts](tauri-app/src/fileListUi.ts) | [tauri-app/src-tauri/src/file_list.rs](tauri-app/src-tauri/src/file_list.rs) |
| PDF 转 Excel（`pdf_to_excel`） | [tauri-app/src/PdfToExcelPage.tsx](tauri-app/src/PdfToExcelPage.tsx) · [tauri-app/src/pdfToExcelUi.ts](tauri-app/src/pdfToExcelUi.ts) | [tauri-app/src-tauri/src/pdf_to_excel.rs](tauri-app/src-tauri/src/pdf_to_excel.rs) |
| AudiPick（`audipick`） | [tauri-app/src/AudiPickPage.tsx](tauri-app/src/AudiPickPage.tsx) · [tauri-app/src/audipickUi.ts](tauri-app/src/audipickUi.ts) | [tauri-app/src-tauri/src/audipick.rs](tauri-app/src-tauri/src/audipick.rs) |
| Roll Forward（`audit_roll_forward`） | [tauri-app/src/RollForwardPage.tsx](tauri-app/src/RollForwardPage.tsx) · [tauri-app/src/rollForwardUi.ts](tauri-app/src/rollForwardUi.ts) | [tauri-app/src-tauri/src/roll_forward.rs](tauri-app/src-tauri/src/roll_forward.rs) |
| WP 服务单（`wp_service_generator`） | [tauri-app/src/WpServicePage.tsx](tauri-app/src/WpServicePage.tsx) | [tauri-app/src-tauri/src/wp.rs](tauri-app/src-tauri/src/wp.rs) |
| 两列模糊匹配（`fuzzy_match`） | [tauri-app/src/FuzzyMatchPage.tsx](tauri-app/src/FuzzyMatchPage.tsx) | [tauri-app/src-tauri/src/fuzzy_match.rs](tauri-app/src-tauri/src/fuzzy_match.rs) |

> 表格里每个路径都是相对**仓库根**的完整路径，在 GitHub 上点击可直接打开对应文件。

侧边栏分组与可折叠子分组在 [tauri-app/src/App.tsx](tauri-app/src/App.tsx)（`TOOL_SUBGROUPS` 与其下的分组 `ids`）。

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

---

# 贡献规范

以下是所有代码改动都要遵守的规矩。标了 **[自动拦截]** 的条目有测试或发布门禁把守，违反了直接构建失败；其余靠 Review 把关。

## 一、通用硬约束

- **[自动拦截]** **前端没有任何直接文件权限**：Tauri capability 只开了 `core:default`，所有路径都经 `AllowedPaths` 白名单。让用户选文件用 `pick_path`（系统对话框），选中后才授权该路径。不要绕开白名单。
  白名单语义必须保留：**选中目录授权其后代，选中/生成的文件只授权该文件本身，绝不反向授权其祖先目录**（否则一个 `C:\x\y.xlsx` 会授权整个 `C:\`），`lib.rs` 有专门的回归测试。
- **[自动拦截]** **未知 method 必须报错**：`engine_call` 返回 `METHOD_NOT_FOUND`，`job_start` 同理，`job_cancel` / `job_pause` 对未知任务返回 `JOB_NOT_FOUND`。**不允许静默回退或忽略**。
- **[自动拦截]** **method 命名是 `<命名空间>.<动作>`**，命名空间必须在白名单内（`fa` / `ts` / `kanzhang` / `roll_forward` / `audipick` / `fx` / `loan` / `deposit` / `fuzzy` / `pdf2excel` / `confirmation` / `excel_merger` / `file_list` / `wp`）。新增命名空间要同时改 `lib.rs` 的分发分支和 `src/toolDefinitions.test.ts` 的白名单。
- **耗时任务 = worker 进程**：worker 里不能使用 Tauri state，所需的设置必须由 `lib.rs` 在分发前注入进 params（见 `inject_fa_settings` / `inject_roll_forward_llm`）。
- **错误一律走 `AppError` 契约**：`code` / `userMessage` / `retryable` / `diagnosticId` 四个字段，前端按这个契约展示。不要在页面里拼裸错误字符串。
- **跨边界数据用 zod 校验**（`src/types.ts`）。
- **面向用户的文案一律中文**（错误信息、进度提示、Sheet 名），且不用 `✅`/`❌` 这类装饰性符号——Windows GBK 控制台会报编码错误，内部审计工具也要保持克制风格。
- **打包必须走 Tauri CLI**（`npm run tauri:build`）。直接 `cargo build --release` 产出的 EXE 会把界面指向开发地址，脱离开发机就是白屏。
- **数据与内嵌资源**：本机数据在 `%LOCALAPPDATA%\AuditToolbox\AuditToolbox\data`（SQLite）。编译期内嵌的资源（如 `assets/wp/FY27+WP服务单.xlsx.b64` 模板）修改后必须重新编译 Rust 才生效。
- **LLM 密钥**：配置经 SQLite + Windows 凭据管理器保存，只保存在本机，**不提交到 GitHub**。`secret_set` 只接受 `llm_api_key` / `dify_api_key` / `baidu_ocr_key` / `baidu_ocr_secret` 四个名字，其余拒绝。
- **不改仓库根目录的旧 Python 栈**（见文末「遗留的旧 Python 栈」）。

## 二、加一个新工具要做的六件事

1. **注册到清单**：在 `tauri-app/public/tool-catalog.json` 加一条（`id` / `name` / `description` / `route` / `version` / `capabilities` / `migrationStatus`）。**[自动拦截]** Rust 侧有"数量与实际一致且 id 唯一、每条都有 route"的测试——加完工具要同步改那个数字。
2. **决定界面形态**：
   - 表单 + 按钮就够的简单工具 → 在 `src/toolDefinitions.ts` 里用声明式 `fields` + `actions` 加一条，由通用 `ToolPage` 渲染，**不要新建页面文件**。**[自动拦截]** 有测试要求每个工具至少有一个 `primary` 主操作。
   - 多步骤、需要预览/映射/进度的复杂工具 → 建独立页面文件，但**必须复用公共组件**（见第四节）。
3. **写 Rust 业务模块**：新建 `src-tauri/src/<tool>.rs`，所有文件读取、解析、计算、Excel 生成都在这里。前端不做业务计算。
4. **在 `lib.rs` 登记**：把 method 加进 `engine_call`（短任务）或 `job_start`（耗时任务）的分发分支；耗时任务还要在 `excel_merger::is_supported_job_method` 里显式登记。
5. **挂进侧边栏**：在 `src/App.tsx` 的分组 `ids` 里选一组放进去（审计工具 / 效率工具 / 运营工具），同系列工具可以用 `TOOL_SUBGROUPS` 收成可折叠子组。
6. **补测试与文档**：前端交互逻辑抽成纯函数放 `*Ui.ts` 并写 vitest；Rust 侧写单元测试；改动已有工具的业务口径时同步更新对应的 `*_PARITY.md`。

## 三、涉及 TB / JE 的功能：必须走统一账表引擎

**这条是强制的。** 任何需要读试算平衡表（TB）或序时账（JE）的功能，**不允许自带表头识别、字段映射或借贷方向判定**。

内核在 [tauri-app/src-tauri/src/ledger_mapping.rs](tauri-app/src-tauri/src/ledger_mapping.rs)，前端面板是 [tauri-app/src/components/MappingPanel.tsx](tauri-app/src/components/MappingPanel.tsx)。汇兑损益、存款利息、借款利息、看账、正负数标记五个工具已经全部收敛到它上面，方案与踩坑记录见 [tauri-app/LEDGER_MAPPING_UNIFICATION.md](tauri-app/LEDGER_MAPPING_UNIFICATION.md)。

**接进来能白拿到的东西**：

- 标准角色词汇表（JE 一份、TB 一份，每个角色带别名、冲突词、能否多列、是否必填、方案组、币种口径），来源是真实客户样例里的金标类型表（TB 六型、JE 三型）
- 读表与表头探测（两层表头合并、Excel 日期还原、大文件轻量路径、稳定 Parquet 缓存——实测 36 万行序时账首次 44 秒、再次 6.3 秒）
- 按别名＋数据形态给每列打分，生成候选与建议映射；形态整组匹配
- 借贷符号方向判定、余额与发生额的统一折算、集团货币列排除与本位币反判
- LLM 复核（`ledger.review_mapping`，提示词从角色清单**自动生成**，不用手写）
- 旧角色名迁移层（改名后历史任务参数仍可读）
- 前端统一映射面板：表头下拉选角色、多列角色、方案组互斥置灰、必填提示、复核入口、口径核对展示

**规矩**：

- 工具只**声明自己要哪几个角色**（`availableRoles`），不复制任何映射代码，也不自带私有角色表。
- 角色的中文标签由后端随识别结果下发，前端不要各自硬编码。
- 需要工具特有的别名写法（例如存款利息把"文本／科目文本"也算辅助核算），**在自己模块里追加，不要改标准表**——标准表保持保守，否则会抢走别的工具的列。
- ⚠️ **例外：业务台账不走共用读表。** 共用的表头探测内置了账表语义先验（按科目、金额、日期这类词打分），拿它扫借款登记簿这类业务台账会把数据行当表头（实测某份台账被判到第 9 行，整张表识别不出一笔借款）。**TB / JE 必须走内核；业务台账保留本模块自己的表头探测。**
- 改内核前先跑真实样例的 `#[ignore]` 测试，命令见 `LEDGER_MAPPING_UNIFICATION.md`（其中 LLM 复核那条会调用外部接口并产生费用）。

## 四、界面与交互一致性

**样式一律引用设计变量，不要写颜色/字号/圆角/间距的字面量。**
变量定义在 [tauri-app/src/styles.css](tauri-app/src/styles.css) 顶部的设计变量层——它是从 173 个杂色、16 种字号、11 种圆角、22 种间距收敛出来的：50 个颜色变量、7 级字号（`--fs-xs` … `--fs-3xl`）、3 级圆角 + 胶囊（`--r-sm` / `--r-md` / `--r-lg` / `--r-pill`）、7 级间距（`--sp-1` … `--sp-7`）。同级元素引用同一个变量，改一次全局生效；写字面量就会重新把它打散。

**优先复用现成组件，不要自己再造一个。**

| 层 | 位置 | 内容 |
|---|---|---|
| 基础控件 | `src/components/ui/` | button / input / card / table / badge / alert / progress / separator（shadcn + Radix + Tailwind v4） |
| 业务公共件 | `src/components/` | `FileDropInput`（拖放/点选上传）、`DataTable`（数据预览）、`ColumnFilterMenu`、`StepIndicator`（步骤条）、`JobProgress`（任务进度）、`PageHeader`、`ResultCard`、`ResultView`、`StatGrid`、`ErrorBox`、`MappingPanel`（账表映射）、`LedgerLlmReview` / `LedgerMappingPreview` / `LedgerSourceCard`、`LlmReview` |

**交互约定**：

- **选文件**用 `FileDropInput`，底层走 `pick_path`；不要自己写文件输入框。
- **耗时操作**用 `job` + `JobProgress`，让用户看得到进度、能取消；不要用没有反馈的同步长调用。
- **防重复提交**：主操作在执行期间必须禁用，并给出"处理中"状态。
- **阻断式校验的文案要说清"为什么不能继续"和"回到哪里处理"**（现有写法是"无法进入下一步／无法导出" + 指明区域），不要只弹一句"失败"。
- **可选步骤要标明可选**，避免用户误以为必须完成。
- **UI 调整原则**：优先改善信息层级、状态反馈、错误提示、窗口伸缩和操作效率，不改变既有业务流程。
- **页面骨架**：独立工具页使用 `tool-page fx-page`，页头复用 `PageHeader`；同级功能区使用公共 `Card`，不要为单个页面另造一套页头或重复步骤导航。
- **页内步骤导航**：多步工具在 `PageHeader` 下方统一使用 `StepIndicator` 横条（参照看账工具），不得以卡片上的“第一步／第二步”标签代替导航；侧栏总分折叠结构独立保留。
- **同级卡片布局**：桌面宽度下，两块同级、短内容的输入或配置卡片优先左右双列排列（参照“两列模糊匹配”）；窄屏自动降为上下单列，阅读与操作顺序保持一致。
- **宽内容独占整行**：数据预览、字段映射、结果表格和导出区域需要横向空间，应跨满整行，不挤进半宽卡片。

## 五、提交前自查清单

```
[ ] npm test 通过
[ ] cargo test --manifest-path src-tauri/Cargo.toml 通过
[ ] 新增/改动的 method 已在 lib.rs 分发分支登记，未知 method 仍会报 METHOD_NOT_FOUND
[ ] 新增工具已加进 tool-catalog.json，并同步改了 Rust 侧的工具数量断言
[ ] 涉及 TB / JE 的部分调用了 ledger_mapping，没有自带表头识别或映射代码
[ ] 新增样式只引用设计变量，没有颜色/字号/圆角/间距字面量
[ ] 复用了 src/components/ 里的公共组件，没有重复造 FileDropInput / DataTable / JobProgress
[ ] 面向用户的文案是中文，且不含装饰性符号
[ ] 文件路径都经 pick_path 白名单，没有绕开
[ ] 密钥、客户样例、测试数据没有被提交
[ ] 改了业务口径的，已同步更新对应 *_PARITY.md
[ ] 改了版本号的，四处都改了（见下方「打包发布」）
```

---

## 日常维护：改一个工具要动哪些文件

1. **改界面布局、按钮、提示文字** → 改代码地图里对应工具的前端页面（`src/...Page.tsx`）。
2. **改业务逻辑、文件解析、Excel 生成** → 改对应的 Rust 模块（`src-tauri/src/...rs`）。
3. **新增一个业务动作**（例如"增加一个导出按钮"）：
   - 前端：页面里加按钮，调用 `src/api.ts` 的 `call`/`job`（method 形如 `fa.someAction`）；
   - 后端：在 `src-tauri/src/lib.rs` 的 `engine_call` / `job_start` 分发分支里登记这个 method，并实现到对应 `.rs` 模块。**未知 method 必须报错，不允许静默忽略**。
4. **改动业务逻辑后**：同步更新对应 `*_PARITY.md`（如 `FA_RUST_PARITY.md`）中的验收结论，并在本地跑测试。

> 写 `*_PARITY.md` 有两条从教训里来的约定：**不要在文档里写死测试数量**（写运行命令，每加一个测试就过期一次）；**不要把"已实现"写成"已保留全部行为"**（拿不准就逐项列"保留了什么／没保留什么"）。

## 打包发布

### 设置页与更新说明

- 设置分为「AI 与 OCR」「界面主题」「缓存清理」；「软件更新」入口位于设置标题右侧，每次点击都会重新检查。
- 可安装版本仍由 Tauri updater 的 `latest.json` 判断并验证签名；更新说明由 Rust 只读访问同一仓库的 GitHub Releases，按语义版本汇总 `(当前版本, 目标版本]` 内全部已发布说明。没有可安装新版本时显示当前版本说明。
- GitHub Release 缺失说明或只有占位文案时，补充整个升级区间的提交标题并标注来源；网络失败、限流、标签不存在、分页上限均明确提示，不视为「没有变更」。无需配置 GitHub Token，也不上传客户文件或本机设置。
- `.github/workflows/release.yml` 使用 GitHub 自动生成发布说明；发布者仍应提供有意义的 PR/提交标题或人工补充 Release 内容。不会由 LLM 猜测更新了什么，旧版未写的功能说明不能凭空还原。
- 验证：`npx vitest run src/AppNavigationSettings.test.tsx src/api.test.ts --exclude='**/.claude/**'`；`cargo test --manifest-path src-tauri/Cargo.toml update_notes:: --lib`。只读联网测试另加 `github_live_release_notes -- --ignored`；下载安装需使用签名发布版单独验收。

一键打包（推荐，已修复可直接使用）：

```bash
# 在 tauri-app/ 目录下
python scripts/build_tauri_release.py --reuse-dependencies
# 或双击「打包Tauri审计工具箱.bat」
```

产物在 `tauri-app/dist/`：`E点通工具箱-v<VERSION>-win-x64.exe` 及同名 `.sha256`。脚本不会覆盖旧版 EXE，每个版本单独产出。

**版本号有四处，改版本时必须同步**：`package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`、`scripts/build_tauri_release.py` 顶部的 `VERSION`。

**[自动拦截]** **发布门禁**：打包后脚本会用发布 EXE 自身的 worker 入口做冷启动验收（Excel 合并、TS、看账、FA、WP、Roll Forward），并断言**没有 Python 子进程、没有新增 Python runtime**。改业务模块时保证这些 worker 路径仍能跑通，否则打包直接失败。

## 遗留的旧 Python 栈

仓库根目录的 `launcher/`、`tools/`、`modules/`、`audit_engine/`、`suite_main.py`、`build_suite.py` 是 Tauri 迁移前的 tkinter + Python 版本，**只保留作迁移金标与回归测试，不参与生产运行，也不进入发布 EXE**。维护生产代码时不要修改它们；只有做新旧行为对照时才读 `audit_engine/handlers.py` 等金标文件。

## License

MIT
