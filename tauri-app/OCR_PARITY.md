# OCR 独立工具验收约定

本工具参考 AudiPick 的服务适配、场景定义和财务契约证据核验；项目、源文件副本、分页校对和摘录结果使用独立存储，不迁移或改写 AudiPick 项目。

## 能力与边界

| 能力 | 本次实现 | 对应验收 |
| --- | --- | --- |
| 项目与文件 | 独立 SQLite 项目、按项目保存提示词、PDF/PNG/JPEG/BMP/多页 TIFF；选择或拖入的多个文件夹与文件混合递归导入，按实际规范路径去重、跳过不支持格式，空目录明确提示；保存源文件副本 | `ocr_store::tests`、`ocr::tests::import_`、`OcrPage.test.tsx` |
| 上传交互 | 复用工具箱 `FileDropInput`，点击选择与桌面原生拖放共用导入，悬停高亮；已有文件时可继续添加，忙碌和保活隐藏页不接收文件 | `OcrPage.test.tsx`、`useNativeFileDropZone.test.tsx`、`nativeFileDragApi.test.ts`；浏览器预览不冒充本机文件操作 |
| 识别 | AI 视觉与百炼一次请求返回全文/表格；纯文本 OCR 可由全局 AI 辅助还原；仅全局配置，不继承 AudiPick 专用模型 | `audipick::tests::toolbox_`、`bailian_ocr::tests` |
| 配置测试 | 设置页直接测试所选引擎；百度／百炼可使用草稿，AI 视觉仅使用已保存全局 LLM；内置图片、不保存草稿、显示耗时及失败原因 | `AppNavigationSettings.test.tsx`、`audipickOcrApi.test.ts`、`audipick::tests::toolbox_ocr_test_never_uses_audipick_dedicated_model` |
| 项目与文件 | 独立 SQLite 项目、按项目保存提示词、PDF/PNG/JPEG/BMP/多页 TIFF、文件夹递归导入，保存源文件副本 | `ocr_store::tests`、`OcrPage.test.tsx` |
| 识别 | 百炼兼容接口使用官方默认纯文字识别提示词，本地解析其返回的 Markdown／HTML 表格，不强迫模型生成 JSON；统一 AI 兼容结构结果；纯文本 OCR 可由全局 AI 辅助还原。损坏 JSON 仅恢复确定内容并提示重试；仅全局配置，不继承 AudiPick 专用模型 | `audipick::tests::toolbox_`、`bailian_ocr::ocr_content::tests`、`bailian_ocr::tests` |
| 版面 | 默认整页；左右双页由用户选择，同一物理页按左、右顺序合并后保存，不按横向比例误切表格 | `ocr::tests`、`OcrPage.test.tsx` |
| 图片 | BMP 转 PNG；TIFF 每帧按顺序解码为 PNG；PDF 使用内嵌 PDF.js 渲染，不引入 Python 运行时 | `ocr::tests::tiff_decodes_every_frame_in_order` |
| 校对与恢复 | 本次识别原文只读可复制，识别表格行列可校对，无新增空表格；旧人工正文折叠保留并继续用于导出/摘录。重试更新当前原文基线，旧原始响应保留在独立诊断表；页版本防止迟到覆盖，文档版本判断摘录是否过期 | `ocr_store::tests`、`OcrPage.test.tsx` |
| 流程 | 原文识别、判断摘录为两步独立工作区；扫描件/原文等高，表格全宽；证据返回第一步，场景与全部可编辑提示词放第二步 | `OcrPage.test.tsx`、浏览器合成资料视觉验收 |
| 场景与提示词 | 手动选择 AudiPick 既有单证/合同场景及自定义；显示实际默认提示词并允许逐阶段编辑、恢复默认、按项目保存 | `ocrScenarios.test.ts`、`OcrPage.test.tsx` |
| 财务契约 | 调用与 AudiPick 页面相同的 `extractFinancialMetrics` 及启用案例库；提示词可覆写，原文继续按行号回填和核验 | `ocrScenarios.test.ts`、`audipickPreviewFinancialCovenant.test.ts` |
| 长文摘录 | 分段并重算证据页码；借款通用场景有独立可编辑汇总阶段；无逐字证据的表格结果明确标记具体出处待核对 | `ocrScenarios.test.ts` |
| Excel | 每文件一份及项目合并；目录、来源页码、完整原文、独立表格和可读摘录。不导出提示词、内部追踪/版本及坐标；实际提示词仍保存在项目中供查看。单元格按文本保存，长内容无损续行，过期摘录和缺页显式标记 | `ocr_export::tests`、`scripts/verify_ocr_workers.py` |
| 任务 | worker 独立进程，暂停/取消/继续；失败页保留待重试，空响应和截断不冒充完成；识别图片与摘录正文不保存到通用任务参数 | `ocrApi.test.ts`、Rust worker 路由及存储测试 |
| 安全 | 导入和导出均检查用户选中路径；原生拖放事件授予实际投递路径；导入目录不跟随重解析点/链接，投递的重解析点根路径也拒绝；内部存储路径由主进程注入 | `ocr_import_and_export_require_selected_paths_without_parent_grants`、`ocr::tests::import_directory_never_follows_junctions_or_accepts_junction_roots` |

## 不包含的既有专用工作流

旧版因结构失败而未保存的正文无法从现有 Excel/分页记录补回；清理协议内容不等于完整识别，需对原扫描件重新识别。HTML 合并单元格展开为原行列空位，保留左上格文字并提示核对，本轮不承诺复刻所有版式。原始响应不通过普通页面或 Excel 展示。

不复制 AudiPick 的收入审阅底稿套用、合同关系分组、项目备份和案例库维护界面。跨页表格分别保留，不自动推断合并；输出以完整文字、可编辑行列和来源定位为目标，不复制印章、手写签名或扫描版式。模糊、缺损文字和表格仍需人工校对。

## 验证命令

```text
npx vitest run src/ocrApi.test.ts src/ocrScenarios.test.ts src/OcrPage.test.tsx
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib ocr
cargo test --manifest-path src-tauri/Cargo.toml --lib audipick::
cargo test --manifest-path src-tauri/Cargo.toml --lib bailian_ocr::
python scripts/verify_ocr_workers.py --exe src-tauri/target/debug/audit-toolbox.exe
```

原生命令在已注入 MSVC 环境的 PowerShell 7 执行，统一使用 `src-tauri/target`。worker 验收只使用合成资料与临时数据库，不访问真实项目、修改真实服务配置或上传真实单证；真实服务 OCR 质量不由离线夹具替代。

## 2026-10-27 验收记录

- 前端构建通过；页面、场景、API、既有 AudiPick 提取、工具导航和导览定向回归通过。全量前端回归发现新增工具未登记状态夹具及扫描页阴影未引用设计 token，修复后相关守卫与 OCR 页面/场景复测通过。
- Rust `--lib ocr` 与 `--lib audipick::` 通过，原默认忽略的服务/COM 测试仍未执行。覆盖百炼结构化协议、本地模拟模型的截断与 PNG MIME、源版本冲突及 Excel 回读；该离线回归与下述用户授权真实服务测试分开记录。
- 新编译 debug EXE 通过 `verify_ocr_workers.py`：项目合并、逐文件导出、同名不覆盖、长账号与公式字面保真、未完成页和过期摘录标记、实际提示词、取消前不发布及禁用 AI 的明确错误。仅使用临时 SQLite 和合成资料。
- 浏览器合成演示在 1440 和 1000 像素宽度通过原扫描页/表格预览、完整提示词编辑与项目保存、切换场景恢复及实际摘录流程；无页面横向溢出、无未标注输入框和页面异常。截图及检查记录位于 `artifacts/ocr-20261027/`。
- 新导入的多页 PDF/TIFF 在预览中确认并保存真实页数，识别前即可翻页；相应页面回归通过。当前未更新应用版本或替换已安装程序。
- 原生拖放传入的 `paths` 同时接受文件和目录，与选择文件夹共用递归导入逻辑；回归夹具覆盖多目录与文件混合、重复路径、格式过滤、空目录提示及 Windows junction 拒绝，路径授权仍由原主进程入口校验。

## 用户授权合同实测（2026-10-27）

用户提供的 20 页纯扫描合同仅放本机忽略目录，沿用已保存 Dev 百炼配置及 qwen3.5-ocr。封面、表格页、公式页先行对比：自定义 HTML 提示会漏掉封面标题和编号；官方默认文字提示词恢复这些内容，并从第 5 页返回可解析的两张 Markdown 表格。生产调用采用后者，仍为每页一次请求。第 9 页的分式和上下标在纯文字中会扁平化，第 5 页千分号被模型误识别、部分选项与空白占位遗漏，第 6 页多行表头漏掉第二行；解析器不推测修正，公式页提示人工对照。真实合同、逐页原始响应及测试导出不进入仓库，不改写用户项目。

完整 20 页真实调用、临时项目保存及原生 Excel 导出已通过；工作簿回读覆盖全部页码、三张独立表格，无 JSON／坐标协议字段。第 5、6、9 页人工抽查发现已知误读，已写入本地测试工作簿校对提示，未人工改写识别正文，未逐字校对全部合同。真实资料及结果位于本机忽略目录 `artifacts/ocr-20261027/live-contract-test/`。本轮 Rust 定向回归通过，手工服务测试继续保持默认忽略；未推送、未发布、未替换已安装 EXE。
