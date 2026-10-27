# OCR 独立工具验收约定

本工具参考 AudiPick 的服务适配、场景定义和财务契约证据核验；项目、源文件副本、分页校对和摘录结果使用独立存储，不迁移或改写 AudiPick 项目。

## 能力与边界

| 能力 | 本次实现 | 对应验收 |
| --- | --- | --- |
| 项目与文件 | 独立 SQLite 项目、按项目保存提示词、PDF/PNG/JPEG/BMP/多页 TIFF；选择或拖入的多个文件夹与文件混合递归导入，按实际规范路径去重、跳过不支持格式，空目录明确提示；保存源文件副本 | `ocr_store::tests`、`ocr::tests::import_`、`OcrPage.test.tsx` |
| 上传交互 | 复用工具箱 `FileDropInput`，点击选择文件、框内选择文件夹与桌面原生拖放共用导入，悬停高亮；已有文件时可继续添加，忙碌和保活隐藏页不接收文件 | `OcrPage.test.tsx`、`useNativeFileDropZone.test.tsx`、`nativeFileDragApi.test.ts`；浏览器预览不冒充本机文件操作 |
| 识别 | AI 视觉与百炼一次请求返回全文/表格；纯文本 OCR 可由统一 LLM 辅助还原；仅统一 LLM 配置，不继承 AudiPick 专用模型 | `audipick::tests::toolbox_`、`bailian_ocr::tests` |
| 配置测试 | 设置页直接测试所选引擎；百度／百炼可使用草稿，AI 视觉仅使用已保存统一 LLM；内置图片、不保存草稿、显示耗时及失败原因 | `AppNavigationSettings.test.tsx`、`audipickOcrApi.test.ts`、`audipick::tests::toolbox_ocr_test_never_uses_audipick_dedicated_model` |
| 项目与文件 | 独立 SQLite 项目、按项目保存提示词、PDF/PNG/JPEG/BMP/多页 TIFF、文件夹递归导入，保存源文件副本 | `ocr_store::tests`、`OcrPage.test.tsx` |
| 识别 | 百炼兼容接口使用官方默认纯文字识别提示词，本地解析其返回的 Markdown／HTML 表格，不强迫模型生成 JSON；统一 AI 兼容结构结果；纯文本 OCR 可由统一 LLM 辅助还原。损坏 JSON 仅恢复确定内容并提示重试；仅统一 LLM 配置，不继承 AudiPick 专用模型 | `audipick::tests::toolbox_`、`bailian_ocr::ocr_content::tests`、`bailian_ocr::tests` |
| 版面与方向 | UI 固定整页，横向表格不按比例误切；不提供手动角度/版面设置。PDF 自带旋转信息由 PDF.js 处理，再由本机 Windows OCR 对四方向评分，明确胜出才校正像素，保存顺时针纠正角供预览；重扫输入源图防二次旋转。缺语言包或方向不确定时保留原方向并告知，不改写原文件，不增加付费视觉请求。内部旧左右双页 API 仍兼容，界面不再暴露 | `ocr_orientation::tests`、`ocr::tests`、`OcrPage.test.tsx`、`ocrSource.test.ts` |
| 图片 | BMP 转 PNG；TIFF 每帧按顺序解码为 PNG；PDF 使用内嵌 PDF.js 渲染，不引入 Python 运行时 | `ocr::tests::tiff_decodes_every_frame_in_order` |
| 校对与恢复 | 本次识别原文只读可复制，不再显示表格目录及编辑器，识别表格和历史行列校对数据保留用于 Excel 导出，无新增空表格；旧人工正文折叠保留并继续用于导出/摘录。重试更新当前原文基线，旧原始响应保留在独立诊断表；页版本防止迟到覆盖，文档版本判断摘录是否过期 | `ocr_store::tests`、`OcrPage.test.tsx` |
| 流程与扫描范围 | 步骤条在项目信息上方；三列九格可展开。扫描和摘录使用文件勾选范围；卡片点击单选，复选框多选，逐卡片确认删除；清空文件一次确认清理项目全部文件（含未选项），失败项保留并报告，原文件/项目/提示词保留。全部扫描逐文件跳过完成页，失败继续后续文件，自定义范围按各文件页数裁剪并报告，覆盖前统一确认。当前查看文件切换器只改变阅读焦点；原文查看按文件/页序展示所选范围全文，未扫页占位，可一次复制，分页查看恢复本页原文与扫描图对照。不再渲染尾部表格目录与编辑器；文件/分页/阅读模式控件等高底边对齐，翻页按钮相邻，扫描范围与操作按钮同排，范围说明位于文件标题旁，左右预览使用同构标题栏，宽长表内部滚动。导出成功及目录紧邻操作区，证据返回第一步，完整可编辑提示词放第二步 | `OcrPage.test.tsx`、`ocrScanRange.test.ts`、浏览器三页十二表合成资料验收 |
| 场景与提示词 | 手动选择 AudiPick 既有单证/合同场景及自定义；显示实际默认提示词并允许逐阶段编辑、恢复默认、按项目保存；多选逐文件使用相同提示词快照，分别保存与显示来源，未扫描项跳过并报告 | `ocrScenarios.test.ts`、`OcrPage.test.tsx` |
| 财务契约 | 调用与 AudiPick 页面相同的 `extractFinancialMetrics` 及启用案例库；提示词可覆写，原文继续按行号回填和核验 | `ocrScenarios.test.ts`、`audipickPreviewFinancialCovenant.test.ts` |
| 长文摘录 | 分段并重算证据页码；借款通用场景有独立可编辑汇总阶段；无逐字证据的表格结果明确标记具体出处待核对 | `ocrScenarios.test.ts` |
| Excel | 文件区多选、全选包含收起文件，选择状态与查看文件独立；仅工作区保留一个导出入口，导出弹窗列明勾选范围，不再另设当前/全部范围。支持一个 Excel 一个 Sheet（按文件/页码分区）、一个 Excel 多 Sheet（每文件一张）、多个 Excel（每文件单独、内部原文/表格/摘录分表）。保留旧合并 API，不按未知表头自动拼列。原文/原行列表格/可读摘录完整输出，缺页及过期摘录显式标记，不导出提示词或内部追踪。长内容无损续行、账号和公式字面按文本保存，不覆盖同名文件 | `OcrPage.test.tsx`、`ocr_export::tests`、`scripts/verify_ocr_workers.py`（旧合并兼容） |
| 任务 | worker 独立进程，暂停/取消/继续；失败页保留待重试，空响应和截断不冒充完成；识别图片与摘录正文不保存到通用任务参数 | `ocrApi.test.ts`、Rust worker 路由及存储测试 |
| 并发与耗时 | 同文件前端默认最多 5 页在途，后台 OCR 独立通道最多 5 个 worker，不经过其他重任务的串行锁；乱序完成按已处理数量推进，失败不阻塞其他页；暂停／取消覆盖全部在途任务及迟到编号，恢复唤醒全部等待者，退出后再释放文件。逐页展示渲染、提交／往返、后台排队及后端处理分段耗时，总时间包含暂停；并发耗时不相加，不混入正文和 Excel | `job_dispatch::tests`、`excel_merger::tests::ocr_dispatch_queue_time_is_attached_without_changing_other_results`、`ocrBatch.test.ts`、`ocrApi.test.ts`、`OcrPage.test.tsx`、`scripts/verify_ocr_dispatch.py` |
| 安全 | 导入和导出均检查用户选中路径；原生拖放事件授予实际投递路径；导入目录不跟随重解析点/链接，投递的重解析点根路径也拒绝；内部存储路径由主进程注入 | `ocr_import_and_export_require_selected_paths_without_parent_grants`、`ocr::tests::import_directory_never_follows_junctions_or_accepts_junction_roots` |

## 不包含的既有专用工作流

旧版因结构失败而未保存的正文无法从现有 Excel/分页记录补回；清理协议内容不等于完整识别，需对原扫描件重新识别。HTML 合并单元格展开为原行列空位，保留左上格文字并提示核对，本轮不承诺复刻所有版式。原始响应不通过普通页面或 Excel 展示。

不复制 AudiPick 的收入审阅底稿套用、合同关系分组、项目备份和案例库维护界面。跨页表格分别保留，不自动推断合并；输出以完整文字、可编辑行列和来源定位为目标，不复制印章、手写签名或扫描版式。模糊、缺损文字和表格仍需人工校对。

## 验证命令

```text
npx vitest run src/ocrApi.test.ts src/ocrScenarios.test.ts src/OcrPage.test.tsx
npx vitest run src/ocrBatch.test.ts src/apiJobDelivery.test.ts src/ocrSource.test.ts src/ocrScanRange.test.ts
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib ocr
cargo test --manifest-path src-tauri/Cargo.toml --lib native_ocr_corrects_real_synthetic_text_in_all_four_directions -- --ignored --nocapture
cargo test --manifest-path src-tauri/Cargo.toml --lib audipick::
cargo test --manifest-path src-tauri/Cargo.toml --lib bailian_ocr::
cargo test --manifest-path src-tauri/Cargo.toml --lib job_dispatch::
cargo test --manifest-path src-tauri/Cargo.toml --lib ocr_dispatch_queue_time
python scripts/verify_ocr_workers.py --exe src-tauri/target/debug/audit-toolbox.exe
python scripts/verify_ocr_concurrency.py --exe src-tauri/target/debug/audit-toolbox.exe
python scripts/verify_ocr_dispatch.py --test-exe <本次编译的lib测试EXE> --worker-exe <原生程序EXE>
```

原生命令在已注入 MSVC 环境的 PowerShell 7 执行，统一使用 `src-tauri/target`。worker 验收只使用合成资料与临时数据库，不访问真实项目、修改真实服务配置或上传真实单证；真实服务 OCR 质量不由离线夹具替代。

并发 worker 验收会临时监听 `127.0.0.1:8765`，利用同步屏障确认三个识别请求同时在途，再以不同延迟返回；若已有本机 OCR 服务占用该端口，先自行选择合适的验收时间，不终止或覆盖已有服务。前端默认五页上限及控制行为由 `ocrBatch.test.ts`、`OcrPage.test.tsx` 验收。逐页耗时是当前任务的诊断数据，失败页仅有前端已测阶段，未返回的后端阶段不估算；本轮统计不跨页面重载保存。实际服务可能限流，增加并发不保证线性提速。

上述旧 `verify_ocr_concurrency.py` 和此前真实服务档位测速直接启动 worker，绕过了父进程调度，不能证明安装版界面已经并发。新增 `verify_ocr_dispatch.py` 通过实际 `ExcelMergerService::start → monitor → worker`，本机屏障要求五个请求全部到达才返回，同时检查分页保存及排队耗时。它同样使用临时数据库和本机端口，不调用付费服务。当前机器的 lib 测试 EXE 因缺少 Common Controls v6 清单在进入测试前报 `0xC0000139`；本轮对测试 EXE 的本机副本用 Windows SDK `mt.exe` 嵌入 v6 清单后运行，未修改系统运行库或已安装程序。

## 2026-10-27 验收记录

- 多选统一范围：页面回归覆盖多文件扫描、失败续扫、取消不派发后续文件、自定义范围裁剪和一次覆盖确认、焦点切换不改变范围、跨文件校对保存、单入口导出、卡片删除、同区文件夹选择、批量独立摘录及正确来源页定位。所选文件的全篇阅读与分页对照并存。定向前端回归通过；日志和浏览器截图位于 `artifacts/ocr-scope-20261027/`。没有新增真实服务调用或替换安装版。

- 修复实际调度串行：此前所有 `monitor` 都持有全局重任务锁，前端五页在途实际逐页启动。OCR 页面改用独立五名额通道，其他方法继续串行；名额保持到 worker 退出，排队中的取消及时返回。Rust 调度上限／释放／取消／其他任务串行及排队字段测试、本机五请求屏障验收通过；OCR 页面/API/并发前端回归与构建通过。未发布或替换安装版。
- 用户授权上海电气合同速度复测：沿用已保存 Dev 百炼配置、同一批渲染 PNG，经修复后的真实父进程调度、已安装 Dev 程序的 worker 入口，在隔离数据库运行。同样前五页，后台单名额 33.1918 秒，五名额 8.4507 秒；完整三十页五名额 41.0514 秒，全部完成，峰值五个运行任务，最大后台排队 100.79 毫秒。共四十次真实服务请求。计时包括启动、图片处理、识别、保存和进程退出，不包括 UI、PDF.js 渲染、真实项目的通用任务历史写入；测试不改真实项目或凭据。原 PDF 只读，Poppler 单独渲染 35.16 秒，不能当作应用内渲染时间；截图 207.18 秒仅为用户现场参考，未重跑完整旧版作严格对照。私有原图、响应和详细报告仅存忽略目录 `artifacts/ocr-dispatch-20261027/shanghai-live/`。
- 全篇阅读与批量导出：OCR 页面/范围/源渲染/场景/API/并发及工作流布局定向回归、前端类型检查与构建通过；Rust `--lib ocr` 回归通过，真实服务测试继续忽略。本机合成单证的 0/90/180/270 度方向验收显式执行通过；页方向元数据人工保存保留。十二文件多选/全选（含收起项）和单表跨页编辑通过；原生 Excel 回读验证非相邻文件选择、单 Sheet/按文件分 Sheet/分别工作簿、前导零、公式字面、长文续行、缺页及摘录输出。浏览器使用三页十二表合成资料检查宽表内部滚动、按钮靠右、导出范围与成功目录，未调用真实服务或替换已安装程序。日志与截图位于 `artifacts/ocr-refinement-20261027/`。
- 用户确认采用默认五页并发：`OCR_CONCURRENCY` 从 3 改为 5，扫描提示和耗时说明引用同一常量。前端回归覆盖最多五页在途、按空位派发、失败后仅续扫缺页、五个等待者恢复及取消迟到任务；验证命令见上方。不改变历史测速记录，本次不重复付费请求。
- 并发档位追加实测：同合同第 1—12 页、同尺寸已渲染 PNG、同 Dev 百炼模型与原生 Rust 入口，依次对比 3／5／8 页并发，批次总耗时为 44.055／26.039／25.589 秒，单页平均耗时为 9.724／9.595／13.825 秒，36 次真实请求均完成。5 比 3 的批次耗时减少 40.89%；8 比 5 仅节省 0.450 秒，且单页平均耗时升高。各档仅一轮，不含前端渲染／UI，不确定具体饱和环节，未逐字验同或测完整应用峰值内存；默认并发仍为 3，未因测速修改。详细报告仅存本机忽略目录 `artifacts/ocr-20261027/live-contract-test/speed-20261027-181134/`。
- 后续用户授权速度实测：使用既有合同第 1、2、4、5、6、9 页，同一批已渲染 PNG（1786×2526），沿用 Dev 百炼凭据与 qwen3.5-ocr，通过已编译 Rust 手工验收入口逐页启动独立进程；串行 63.104 秒，最多 3 页并发 20.840 秒，共 12 次真实请求全部完成。本次批次耗时减少 66.98%，吞吐比约 3.03；为单轮对比，受网络、服务负载和生成波动影响。计时包含原生识别、解析、隔离项目保存／导出及进程开销，不含前端 PDF 渲染和 UI 派发，不是安装版完整界面的端到端测速；未改写真实项目或凭据。两轮仍返回第 5 页两表、第 6 页一表，公式提示保留，文字有模型波动、未逐字验同。报告及私有结果仅存本机忽略目录 `artifacts/ocr-20261027/live-contract-test/speed-20261027-180436/`。
- 多页并发与耗时：前端并发池、OCR API／页面／场景、任务事件和工作流布局定向回归及 `npm run build` 通过；补充取消前任务编号尚未返回的页面回归通过。Rust `cargo test --manifest-path src-tauri/Cargo.toml --lib ocr` 通过，原有真实服务测试保持忽略。新编译 debug EXE 通过 `verify_ocr_concurrency.py`：本机合成服务同步屏障确认三个请求同时在途，分页写入完整、文档修订递增正确、旧版本在网络前被拒绝、耗时字段完整且未写入页正文；同一 EXE 通过原 `verify_ocr_workers.py` 导出及取消回归。浏览器演示确认耗时入口可展开、旧后端无阶段数据时显示横线，默认窗口无页面横向溢出。只使用临时数据及本机合成服务，未实测真实服务的并发提速、未更新版本或替换安装版。
- 前端构建通过；页面、场景、API、既有 AudiPick 提取、工具导航和导览定向回归通过。全量前端回归发现新增工具未登记状态夹具及扫描页阴影未引用设计 token，修复后相关守卫与 OCR 页面/场景复测通过。
- Rust `--lib ocr` 与 `--lib audipick::` 通过，原默认忽略的服务/COM 测试仍未执行。覆盖百炼结构化协议、本地模拟模型的截断与 PNG MIME、源版本冲突及 Excel 回读；该离线回归与下述用户授权真实服务测试分开记录。
- 新编译 debug EXE 通过 `verify_ocr_workers.py`：项目合并、逐文件导出、同名不覆盖、长账号与公式字面保真、未完成页和过期摘录标记、实际提示词、取消前不发布及禁用 AI 的明确错误。仅使用临时 SQLite 和合成资料。
- 浏览器合成演示在 1440 和 1000 像素宽度通过原扫描页/表格预览、完整提示词编辑与项目保存、切换场景恢复及实际摘录流程；无页面横向溢出、无未标注输入框和页面异常。截图及检查记录位于 `artifacts/ocr-20261027/`。
- 新导入的多页 PDF/TIFF 在预览中确认并保存真实页数，识别前即可翻页；相应页面回归通过。当前未更新应用版本或替换已安装程序。
- 原生拖放传入的 `paths` 同时接受文件和目录，与选择文件夹共用递归导入逻辑；回归夹具覆盖多目录与文件混合、重复路径、格式过滤、空目录提示及 Windows junction 拒绝，路径授权仍由原主进程入口校验。

## 用户授权合同实测（2026-10-27）

用户提供的 20 页纯扫描合同仅放本机忽略目录，沿用已保存 Dev 百炼配置及 qwen3.5-ocr。封面、表格页、公式页先行对比：自定义 HTML 提示会漏掉封面标题和编号；官方默认文字提示词恢复这些内容，并从第 5 页返回可解析的两张 Markdown 表格。生产调用采用后者，仍为每页一次请求。第 9 页的分式和上下标在纯文字中会扁平化，第 5 页千分号被模型误识别、部分选项与空白占位遗漏，第 6 页多行表头漏掉第二行；解析器不推测修正，公式页提示人工对照。真实合同、逐页原始响应及测试导出不进入仓库，不改写用户项目。

完整 20 页真实调用、临时项目保存及原生 Excel 导出已通过；工作簿回读覆盖全部页码、三张独立表格，无 JSON／坐标协议字段。第 5、6、9 页人工抽查发现已知误读，已写入本地测试工作簿校对提示，未人工改写识别正文，未逐字校对全部合同。真实资料及结果位于本机忽略目录 `artifacts/ocr-20261027/live-contract-test/`。本轮 Rust 定向回归通过，手工服务测试继续保持默认忽略；未推送、未发布、未替换已安装 EXE。
