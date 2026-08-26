# 正负数智能标记功能矩阵

工具 id `je_sign_mark`，2026-08-21 从看账小工具剪出。
基线不是某个旧版 Python 模块，而是**看账剪出前的行为**——匹配算法整体搬来，未重写。
剪除记录见 [KANZHANG_PARITY.md](KANZHANG_PARITY.md) 末节。

运行验证：

```bash
cargo test --manifest-path src-tauri/Cargo.toml je_mark
```

```bash
npx vitest run src/jeSignMarkUi.test.ts
```

## 与看账共用的部分

下列能力**不是复制，是同一份代码**，看账改一次两边一起变：

| 能力 | 共用实现 |
| --- | --- |
| 文件加载（拖放/选择、Sheet、标题行、进度、取消） | `components/LedgerSourceCard` + `kanzhang.mark_inspect` → `inspect_kanzhang` |
| 字段自动映射、A/B 金额方案互斥 | `suggest_mapping` / `validate_mapping_required` / `ledgerMapping.ts` |
| LLM 映射复核（先斩后奏 + 可撤销清单） | `components/LedgerLlmReview` + `kanzhang.llm_mapping` |
| 预览表与表头映射下拉 | `components/LedgerMappingPreview` |
| 科目取值（多列拼接后的完整科目） | `kanzhang.accounts` |
| 列筛选面板（搜索、全选三态、截断提示） | `components/ColumnFilterMenu`，与 TS 管理共用 |
| 前向填充、异常候选行余额清理 | `preprocess_ledger` |
| 完整凭证筛选 | `filter_ledger_rows` |
| 金额净额判定与跨凭证匹配许可 | `ledger_amounts` |
| 对冲匹配算法 | `match_je_rows` |
| 明细工作簿格式（辅助列灰底、金额格式、目标科目加粗） | `write_kanzhang_detail_workbook` |

## 本工具特有

| 功能 | 实现 | 自动验证 |
| --- | --- | --- |
| 单页流程（无步骤条） | `JeSignMarkPage` | 前端构建 |
| 批次条：新增/删除/改名，各批一套目标科目 | `jeSignMarkUi.addBatch` / `removeBatch` | 批次单测 |
| 目标科目下拉多选（仅批次区常驻入口；预览表头的科目列漏斗与其重复，已移除） | `ColumnFilterMenu` + `JeSignMarkPage` 批次区按钮 | 页面单测 |
| 科目面板把「编码-名称」拼接串拆两段展示（编码灰色等宽），值无编码时用引擎返回的编码补显；搜索同时匹配编码与名称 | `ColumnFilterMenu.splitCode` + `account_values` keyword | 页面单测 + `科目清单带出编码供前端做前缀匹配` |
| 科目多列时按拼接值选，标题注明来源 | `accountFilterTitle` | 科目列定位单测 |
| 跨批次重复提示「已在批次1」 | `batchesContaining` + `ColumnFilterMenu.valueNote` | 批次单测 |
| 科目映射变更即清空已选并提示 | `clearAccountsOnMappingChange` / `accountMappingKey` | 科目字段变更单测 |
| 科目编码与科目名称两个独立角色（与看账同一套） | `accountColumns` / `LedgerMapping::account_columns` | 科目角色拆分测试 |
| LLM 复核结果的应用逻辑与看账完全一致 | `applyLedgerReviews`（两页共用） | 复核应用单测 |
| 任意列取值 | `kanzhang.column_values` | `je_mark_column_values_lists_any_column` |
| 非科目列筛选**按凭证**生效 | `apply_column_filters` | `je_mark_column_filters_keep_vouchers_whole` |
| 三列辅助列 + 完整凭证输出 | `analyze_je_mark` | `je_mark_exports_whole_vouchers_and_marks_only_target_rows` |
| 多批次各出一个文件 | `je_mark_batch_output_path` | `je_mark_multi_batches_write_one_file_each` |
| 空批次拒绝导出 | `je_mark_batches` | `je_mark_requires_a_target_batch` |
| job 事件独立 toolId | `excel_merger::tool_id` | `je_mark_jobs_route_to_their_own_tool` |

## 与看账刻意不同的地方

- **不识别损益结转**。看账把本年利润/未分配利润相关的整张凭证挡在匹配之外，
  本工具没有这道闸门，结转凭证照常参与配对
  （`je_mark_does_not_exclude_profit_transfer_vouchers` 锁住这一行为）。
  用在费用、收入类科目上时，期末结转可能与当期计提配成「已匹配」，未匹配清单会偏乐观。
- **没有透视、套表、凭证类型、LLM 分析、剔除/例外**。产物只有每批次一个明细文件。
- **没有步骤条**，加载、映射、选科目、导出在同一页。

## 输出

每个有效批次一个文件，`.csv` 出 CSV、`.xlsx` 出工作簿。列序：

```
【辅助_绝对值】 【辅助_符号】 【智能匹配状态】 + 原始列
```

命中目标科目的**整张凭证**都在文件里；三列只在目标科目行有值，对方科目行留空。
匹配状态取值：`已匹配-计提` / `已匹配-冲销` / `跨行已匹配-计提` / `跨行已匹配-冲销` / `未匹配` / 空（不参与）。

默认命名 `正负数标记_<源文件名>[_工作表<Sheet>]_<时间戳>.csv`，多批次追加 `_<批次名>_<序号>`。

## 尚未用真实样例验收

目前只有合成回归。**不能据此宣告与剪出前的看账完全等价**。
在宣告前仍需用脱敏真实数据覆盖：方案 A（金额+方向）、方案 A（已带符号金额）、
方案 B（带符号借贷）、多列科目组合、两个以上批次、叠加非科目列筛选、百万行分块。
比较口径：明细行数、三列取值分布、直接/跨行配对数、未匹配行数、每批输出文件。

一个已知的口径细节：符号列按净额判正负（借正贷负），配对另有一套针对红字冲销和
单金额列的处理（`ledger_amounts` 的 `matching`）。两者不是同一个口径，
这是从看账原样继承的行为，本次剪切未做改动。

## 2026-08-22 真实样例：直接配对口径与符号列错位（已修复）

用户用脱敏真实 JE（方案 B 正数借贷，冲销走借方红字，结转走贷方正数）验收时发现：
筛「已匹配」后借贷净额不为 0（管理费用批次 -513.99 万、销售费用批次 -705.57 万），
而跨行匹配两边严格对平。根因是上述"已知口径细节"的直接后果：

- 旧看账 Python 的符号列与配对**同用一个金额**（`__match_amt__`，贷方记正数），
  自洽但错误——"贷方 100 结转"与"借方 -100 红字冲销"净额同号，却被配成计提/冲销；
  按借贷净额核销永不为零。旧版符号列也用该金额，所以错配在旧版输出里看不出来。
- Rust 版符号列已改为净额口径（借正贷负），配对却仍用旧口径，两列矛盾直接暴露
  （该样例中 402 行"计提但符号为负数"、45 行"冲销但符号为正数"）。

修复：`match_je_rows` 直接配对改用净额（`ledger_amounts` 的 `net`），
`matching` 字段随之删除。这是**对旧版的有意偏离**：

- 方案 A（金额+方向）：旧 `matching` 数值与净额恒等，行为不变；
- 方案 B 带符号借贷 / 单金额列：净额即原值，行为不变；
- 方案 B 正数借贷：贷方行从"正数桶"移入"负数桶"，借方红字与贷方结转都算冲销侧，
  借方计提与贷方冲销/结转自此可配对。上述真实样例直接配对从 1383/2201 对增至
  3849/6097 对，两批「已匹配」净额合计均为 0.00（修复前 -513.99 万 / -705.57 万）。

回归锁定：`je_mark_matched_pairs_net_to_zero_on_positive_credit_ledgers`
（贷方正数 + 借方红字，断言配对行净额合计为 0）。

## 2026-08-22 符号口径检测降级链 + 界面确认（新能力，非旧版等价物）

同一份真实样例引出的第二项加固：符号口径（数值是否已带借贷方向）不再只靠
「抽第一张借贷齐全的凭证」猜，改为完整降级链，且结论对用户可见、可推翻：

1. **凭证平衡投票**（铁证）：按匹配键分组，全部借贷齐全的凭证参与投票——
   Σ借≈Σ贷 投「符号一样」，Σ原值≈0 投「已带符号」，都不成立计入「不平衡」。
   不平衡的凭证多于可判定的 → 界面黄牌提示**凭证识别字段可能组错**
   （比如缺公司或日期，把不同凭证串成同一键）。
2. **列级兜底**（筛过的账）：全文件没有借贷齐全的凭证时，按「红字是少数」
   推断——借贷分列看贷方列多数符号；金额+方向看负数金额落在哪个方向
   （负数集中贷方向=已带符号，集中借方向=红字、金额为正）。
   此时界面黄牌提示**账可能被筛选过，请确认口径**。
3. **单一金额列**：天然已带符号，不提供选择。
4. **人工覆盖**：界面显示检测结论与依据，提供
   自动 / 借贷符号一样 / 已带符号（借正贷负）三档，指定后导出强制采用；
   导出结果回显实际口径与依据。

实现落点：`sign_evidence` / `detect_sign_convention`（tabular.rs），
新查询方法 `kanzhang.mark_sign_report`（与导出同一套预处理和检测），
导出参数 `signConvention`（auto/signed/unsigned），前端 `JeSignMarkPage`
口径卡片 + `JeSignMarkPage.test.tsx`。

对既有行为的影响：

- 借贷齐全凭证齐全的账：从「只抽第一张」变「全量投票」，个别怪凭证不再带偏结论；
  判定结果与旧版一致的文件不受影响。
- **筛过的账判定可能反转**（有意）：旧版找不到借贷齐全凭证时一律按
  「符号一样」（借−贷）折净额；现在带符号的筛过账（贷方为负）会被兜底正确识别。
- 看账（kanzhang）导出路径的 `ledger_amounts` 仍走自动检测（无人工覆盖入口），
  `preprocess_ledger` 同理——其异常行清理也受益于更准的判定。

新增回归：`sign_detection_*` 系列（投票/兜底/方向列交叉验证/单列/键组错/覆盖）、
`je_mark_export_detects_filtered_signed_ledger_and_echoes_convention`、
`je_mark_export_honors_manual_sign_convention`。
尚未用真实样例验收的形态不变，仍以上一节的清单为准。
