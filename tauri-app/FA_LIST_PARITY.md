# FA List：原版与 Tauri 一比一迁移清单

2026-09-23 TB＋JE 性能口径补充：辅助核算属于第一步字段映射验证，不再在
页面就绪后自动扫描，也不按第二步选定的固定资产科目缩小验证范围。用户点击
“复核科目分类”时才验证；TB 未映射辅助或没有有效锚点时后端不读取 JE。
第二步科目清单只按 TB 刷新，不再重读 JE；第三步正式测算复用第一步的
`auxiliaryPlan`，文件或映射指纹失效时才回退重验。回归：
`npx vitest run src/FaPageDesign.test.ts`、
`cargo test --manifest-path src-tauri/Cargo.toml --lib fa_tbje`。

2026-09-20 补充：诺桥美国单侧主体样例中，TB 原始公司代码为 3000、JE 无主体列，复核页现在按公共有效主体显示“默认主体”，使已确认的 4 个原值与 1 个折旧科目可进入测算；旧任务保存的 3000 确认项在身份全集确为默认主体时也能命中。艾维特苏州的 `01-1401-000-000-000` 等分段编码按完整编码分组，不再把 86 个科目压成账套段 `01` 的一行；源表含 5 个固定资产原值科目和 1 个累计折旧科目。回归：`npx vitest run src/FaTbJePage.test.ts`、`cargo test --manifest-path src-tauri/Cargo.toml --lib 单侧映射主体时双方一律按默认主体处理`。

基线以 `tools/fa_list/gui/main_window.py`、`file_and_match_config.py` 以及
`FileHandler → DataPreprocessor → MergeEngine → PivotEngine → Exporter`
实际生效的调用路径为准，不以旧说明文档或废弃页面为准。

2026-09-22 UX 与状态安全补充：工具目录与页内引导现在同时说明“TB＋JE
变动表”和“两期资产清单”两种模式。两期清单第一步的执行按钮明确为“开始
匹配”，匹配完成后立即显示仅期初、仅期末与重复键统计；正文统一为三步。
更换/移除主文件及已有结果后的 Sheet、标题行重读会先确认，并尽量保留新表头
仍存在的人工映射。LLM 复核只提出建议，用户采纳后才写回映射。历史任务优先
恢复带文件指纹的轻量识别快照，无有效快照时自动重读并回到第一步复核。

两种模式的输入、映射或科目分类变化后均保留上一版结果并标记“结果待重算”；
旧结果仅供对照，不可直接导出。TB＋JE 汇总预览支持项目搜索与“只看有差异”。
公共账表来源识别最多并发两份，并显示当前第 N/M 份及文件名；两期清单读取也
把两侧文件名传入页面和同步等待窗。回归命令：
`npx vitest run src/faListUi.test.ts src/FaPageDesign.test.ts src/FaTbJePage.test.ts src/faDropTarget.test.ts`。

已扫描原版 `tools/fa_list` 下 25 个 Python 文件。`main_window.py` 中后定义的
`show_step` 会覆盖前一版本；当前有效主流程只有“文件与匹配 → 可选补充清单 →
自动透视并导出全部列”。`FileSelector`、`MatchConfig`、`DataPreview`、
`PivotConfig`、`ExportSettings` 和旧列选择页仍在源码中，但不在当前有效主流程
上，因此不作为 Tauri 页面复刻目标；其中仍被有效主流程调用的业务算法均继续
由原 Python 内核执行。

## 文件读取与预览

- [x] XLSX/XLS/XLSM/CSV/TXT 读取
- [x] 仅列出可见 Excel Sheet
- [x] 标题行自动识别
- [x] 用户手工指定标题行并重新读取
- [x] 多 Sheet 文件可重新选择 Sheet
- [x] 中文、长路径与重复列名
- [x] 期初/期末行列数和前 12 行数据
- [x] 用表格呈现双文件预览

## 字段与匹配配置

- [x] 多列组合键及左右顺序对应
- [x] 原版默认“资产 ID + 已映射资产名称”的组合键
- [x] 编码列按名称与数据形态自动识别
- [x] 重复列中按覆盖率、唯一率选择真实 ID
- [x] 资产类别值形态嗅探（拒绝 `Y110` 等类别代码列）与长资产名称识别
- [x] 日期、寿命、残值率、原值、累计折旧、本年折旧映射
- [x] 原版正常模式的单侧限制（本年折旧、新增方式、新增时间仅期末）
- [x] 新增日期仅在新增方式已映射时提交
- [x] 原版合并固定参数：自动类型、不去空格、区分大小写、pivot 重复处理
- [x] LLM 自动映射、独立字段复核、匹配键复核及“采纳/不采纳”
- [x] LLM 运行状态、停止、重试和复核明细

## 合并与补充清单

- [x] 使用原 `MergeEngine.perform_full_outer_join`
- [x] 类型标准化、多列全外连接、副卡按位置保留
- [x] 重复键统计不向前端返回客户明细
- [x] 新增清单按组合键回填新增方式/时间
- [x] 处置清单按组合键回填方式/时间/原值/折旧
- [x] 处置金额取绝对值汇总
- [x] 未匹配补充记录单独导出
- [x] 原版三阶段向导及“文件 2 已识别新增字段时自动进入补充步骤”
- [x] 自动进入补充步骤时，以期末文件、Sheet、标题行、组合键和新增字段预填新增清单
- [x] 补充清单按第一步 ID/名称口径逐列自动映射
- [x] 补充清单 LLM ID 口径复核

## 透视、导出与反馈

- [x] 使用原 `PivotEngine`、`Exporter`、`SheetGenerator`、`SummaryGenerator`
- [x] 自动用期初/期末资产类别和四个金额字段建立透视
- [x] 用户未映射资产类别时沿用原版表头回退规则建立透视
- [x] 合并数据、透视、变动汇总、FA List、短寿命卡片、新增/处置 BKD、折旧期间、LLM 分析、异常清单
- [x] 固定资产折旧公式、残值率/寿命纠偏和导出后处理
- [x] 原始来源数据传入重复 ID 回填与模板顺序逻辑
- [x] 导出列名按“文件名 & Sheet”替换 `_文件1/_文件2`
- [x] 将纠偏、未匹配清单、LLM 分析状态改成原版可读提示
- [x] 导出后提供打开文件与再次运行

## 固定资产 TB＋JE 变动表（2026-09-06 行为更新）

2026-09-14 补充：科目复核的主体×科目组合在进入复核页前按用户**当前确认**的 TB／JE 映射重新提取，不再沿用上传时自动建议映射；这修复了 JE 已映射「核算组织」但分类仍挂「默认主体」、最终触发零命中拦截的错配。既有 `FA_TBJE_JE_UNMATCHED` 守卫继续保留，不把未匹配结果伪装为成功。来源标签 TB／JE／TB+JE 仅表示余额表、序时账或两侧出现；资产类别统一去下划线。两期清单与 TB＋JE 子工具切换保留后者草稿。回归：`cargo test --manifest-path src-tauri/Cargo.toml --lib 科目复核按人工映射重新提取主体科目组合`、`npx vitest run src/FaTbJePage.test.ts`。

TB＋JE 变动表模式（`fa.tbje_preview` / `fa.tbje_export`，Rust 实现 `src-tauri/src/fa_tbje.rs`）
本轮四项行为变化，均来自用户对导出底稿与真实混合凭证的走查：

- 透视表合计行 SUM 循环引用修复：原值／累计折旧透视表的合计公式上界此前把
  合计行自身圈进 SUM 区间，Excel 打开导出文件即报「循环引用」警告（用户实测
  累计折旧透视表 B23/C23）。现上界止于最后一条数据行，合计数值缓存不变。
  回归 `pivot_total_formula_stops_at_last_data_row`。
- JE 明细删除「智能匹配状态」列（FA 工具场景不适用）：净额配对状态仍作内部
  口径（净额配对、透视过滤），只是不再导出成列；其后各列整体左移——变动分类
  K→J、变动方式 L→K、是否对方科目 M→L、原始_列从 M 起，汇总表与清单的全部
  SUMIFS 公式引用同步。`assert_export_caches` 的冲销状态改从内存分析按行序
  对照，JE 列号断言同步前移。
- 「在建工程转入」改按在建转出金额锁定：此前对方科目任一贷方命中在建工程
  （编码前缀 1604/1605 或名称含在建工程/cip/工程物资）即整笔判在建转入，
  混合凭证里购入那笔被误判（真在建转入 30,600 与购入 76,725.66 同票）。
  现按凭证归集在建类对方科目贷方净额合计，两轮分配给各新增类别：先精确锁定
  （差额 ≤ 0.05），再足额覆盖（剩余额度 ≥ 新增额 − 0.05）；轮不到的按
  「购入」列示并注明「在建工程转出金额未覆盖本笔增加」（无在建转出金额时
  保留原文案）。保持一行一方式，处置侧（更新改造转入／出售／报废／捐赠）
  判定不变。回归 `mixed_voucher_locks_cip_transfer_by_credit_amount`、
  `cip_counterpart_named_like_category_still_maps_to_cip_transfer`、
  `method_uses_directional_nonzero_counterpart_nets`。
- 预览新增对方科目透视、废弃新增明细预览：透视聚合抽成 `counterpart_pivots`
  （导出与预览同源），`fa.tbje_preview` 新增 `counterpartPivots`（cost／
  depreciation 两组：account／debit／credit，顺序与导出一致）；原 `preview`
  字段（新增明细前 10 笔）随前端「新增明细预览」卡片废弃删除。回归
  `export_reuses_preview_analysis_cache`。

运行命令（不写死数量）：

```bash
cargo test --manifest-path src-tauri/Cargo.toml fa_tbje --lib
```

## 验收门槛

- [x] 现有 FA/Python 回归测试
- [x] 标题不在首行、汇总 Sheet 在前、重复资产编码的回归样例
- [x] 用户 2024/2025 实际样例完成读取、匹配和整包导出
- [x] 用户实际样例按“编码 + 名称”得到 15,831 行，并生成 11 个最终 Sheet
- [ ] 原版与 Tauri 同输入的逐 Sheet 语义对比
- [ ] LLM 开启、关闭、失败、停止、采纳和不采纳分支
- [ ] 文件占用、权限不足、取消、重复运行及超大文件验收
