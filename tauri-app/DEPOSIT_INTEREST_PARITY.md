# 存款利息上传识别行为与性能回归

## 2026-10-08：同码银行明细无法衔接时明确选择

- 第二步 TB-only 账户清单下发同码多名待检查组，只有这些组才通过 `deposit.matching_fallback` 读取全量 JE 预检，支持内存表与磁盘流式读取。普通账户清单不打开 JE。
- 共用明细衔接弹窗：JE 本位币科目汇总沿用存款的逐月还原及月均余额口径；TB 明细两点法对所涉整组生效，保留各银行利率，不混用部分银行的 JE 日期。它不改变借款逐日计算，也不将整份 JE 关闭。
- 汇总通过存款工具内部 `DepositMatchPolicy` 包装实现，只覆盖用户选定的同主体同码组，公共默认身份策略、其他科目及已验证辅助不变。同码明细未全部纳入计息范围或没有期内有效日期 JE 时，禁用汇总。汇总行标为科目汇总并使用新行键，设为须手填利率，不继承第一银行的利率或档位。
- 新口径、所涉组和选择门禁进入快照指纹；正式计算重验资料，选择写入结果与“参数与口径”工作表。变更来源、映射、主体范围、分类、表日或币种口径需重新选择，恢复历史任务也重新确认。未启用选择机制的旧调用保持原行为。
- 验证：`cargo test --manifest-path src-tauri/Cargo.toml --lib deposit_interest::`；`npx vitest run src/DepositInterestInteractions.test.tsx src/components/MatchingFallbackDialog.test.tsx`；`npm run build`。合成金额独立按月均余额核验汇总与两点法，验证跨主体隔离、第二步不打开 JE 和银行利率不串到汇总行。

- 第二步 `reviewAccounts.parentAccountName` 只用于上级与末级名称的单行连接显示及确认表导出；存款身份与分类、金额规则保持原值。

## 2026-10-07：同码汇总分类依据贯通确认与计算

- 标准银行存款编码原有兜底继续有效；自定义编码下仅含户名的明细，继承公共金额勾稽确认的银行存款汇总语义。
- `reviewAccounts` 仅在有可靠分类依据时增补建议角色。确认表按原始主体、科目、有效辅助项、币种保留身份；逐行人工指定优先于自动建议。TB 建户与辅助核算验证使用相同语义，避免确认能识别而计算漏户。
- 验证：`cargo test --manifest-path src-tauri/Cargo.toml --lib 同码分类`；`npx vitest run src/DepositInterestPage.test.ts src/DepositInterestInteractions.test.tsx`。

## 2026-10-07：导出汇总公式缓存

| 行为 | 本次调整与保留边界 | 对应验证 |
| --- | --- | --- |
| 不重算即可读取底稿结果 | 合计、测算减账面差异、绝对差异率写入与现有 Excel 公式一致的计算缓存，不再保存为默认零；保留活公式、可编辑利率和 Excel 自动重算 | `deposit_interest::tests::reconstructs_monthly_balances_and_writes_live_rate_formulas`、`deposit_interest::tests::导出汇总公式缓存保留负差异和零分母口径` |
| 差异方向及边界 | 负差异保留负号；差异率沿用导出公式的绝对值口径，账面为零仍按既有 `IFERROR(...,0)` 保存零；未修改业务测算、用户手填利率、科目分类和货币口径 | 同上，覆盖正负账面、零账面和无差异 |

回归：`cargo test --manifest-path src-tauri/Cargo.toml --lib deposit_interest::`。此条只记录 Rust 导出缓存修复，不代表已验收旧 Python 的全部迁移行为。

原始件验收：01、10、05分别通过当前开发 EXE 的 `--rust-table-worker` 入口执行 `deposit.export`，验证副本直接读取 XLSX 公式缓存（不启动 Excel 重算），合计、测算减账面差异和绝对差异率与独立核验一致；原始输出哈希未变化。05用户手填0.50%按已确认输入接受，本次不修改利率或本位币估算口径。

## 2026-10-07：TBJE 上传性能

本次矩阵记录现有 Rust 行为的保留边界，不代表已验收旧 Python 的全部迁移行为。

| 行为 | 本次保留与调整 | 对应验证 |
| --- | --- | --- |
| 来源分类 | XLSX/XLSM 从 1 MiB 起复用既有约 256 行采样（64 KiB 块末可能含额外行）；采样失败回落完整读取；正式计算不使用样本金额 | `fx::tests::sub_eight_mib_xlsx_classification_keeps_sample_bounded` |
| TB 末级目录 | 末级科目、余额汇总、复核身份目录共用同一掩码；金额前缀只筛选候选，原序累加与半分钱判据保留；原候选结构、排序、锁定和父子边界保留 | `ledger_mapping::tests::相邻勾稽范围缓存与原候选扫描逐行一致`、`金额前缀索引不漏原浮点匹配端点`、`符号区间剪枝保留红字与容差边界`、`编码索引与原非连续父子勾稽逐行一致`、`零值目录索引保持原逐行删除顺序`，以及公共和存款既有回归 |
| 重复导入 | 同一前端会话、同方法和相同参数的未完成读取复用；完成与失败即解除；停止等待仍丢弃本次迟到结果 | `src/components/SyncBusyDialog.test.tsx` |
| 取消范围 | 未新增 Rust 计算取消；换来源或不同参数请求不合并，跨窗口和进程不合并 | 前端复用范围见 `src/api.ts` |
| 性能日志 | 仅 `AUDIT_DEPOSIT_PERF` 开关打开时记录阶段耗时和行数；不记录正文或路径 | 原始件只读诊断测试 |

常规回归：`cargo test --manifest-path src-tauri/Cargo.toml --lib deposit_interest::`、`cargo test --manifest-path src-tauri/Cargo.toml --lib ledger_mapping::`、`npx vitest run src/components/SyncBusyDialog.test.tsx src/DepositInterestInteractions.test.tsx`。

原始件只读诊断：设置 `AUDIT_DEPOSIT_PERF=1`、`DEPOSIT_TB_SAMPLE` 和 `DEPOSIT_JE_SAMPLE` 为两份文件的完整路径，再执行 `cargo test --manifest-path src-tauri/Cargo.toml --lib 存款上传真实账表分段性能诊断 -- --ignored --nocapture`。分别记录来源分类、inspect 各阶段和同进程重复读取；重复识别结果 JSON 必须逐项相同。Debug 测试计时用于定位和同条件比较，不代表发布 EXE 的绝对耗时。

### 本机复测（2026-10-07，Debug）

| 阶段 | 诊断基线 | 完整优化后首次 / 同进程重复 |
| --- | --- | --- |
| TB 来源分类（55,964 行） | 0.43 秒 | 0.45 秒 |
| TB inspect | 136.95 秒 | 4.13 / 3.53 秒 |
| TB 末级判定 | 135.19 秒 | 2.40 / 2.36 秒 |
| JE 来源分类（74,912 行） | 0.32 秒（已启用采样） | 0.32 秒 |
| JE inspect | 5.56 秒 | 5.87 / 1.36 秒 |

基线已合并重复掩码计算，因此只对比一次末级判定；原上传路径曾计算三次。首次代表本次测试进程第一次调用，不代表清空 Windows 文件缓存。重复 inspect 的完整返回 JSON 与首次一致。源码优化后的 Debug EXE 以 `--rust-table-worker` 独立运行 `deposit.export`，完成四页 XLSX 底稿；合成 TB/JE 的银行余额及入账利息用于验证原生执行路径。

回归执行与性能日志见 `artifacts/deposit-upload-performance-20261007.md`。
