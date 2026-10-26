# 存款利息上传识别行为与性能回归

## 2026-10-26：同任务共享完整 TB 分析

同步识别及测算／导出的公共 TB 入口按源缓存、实际角色依赖和上下文要求共享已完成分析及临时库，避免同任务不同阶段重复构建。依赖变化、取消与资源检查保留；不改变完整科目目录、金额验证、账户归集、月份余额、计息或工作簿。机制见 `LEDGER_MAPPING_UNIFICATION.md` 同日条目；回归 `cargo test --manifest-path src-tauri/Cargo.toml --lib deposit_interest` 及完整 `--lib`。此次不是删除首次完整目录所需的读取。

## 2026-10-25：小于 50 MiB 固定普通读取

- 本次有效输入每份均严格小于 50 MiB（52,428,800 字节）时，固定普通模式，忽略展开体积、工作倍率、内存水位和旧磁盘计划，不开启磁盘任务的内存启动等待／自动暂停。多份小文件不按大小总和突破门槛；达到门槛恢复原动态判断。
- 含大文件的混合任务仍可使用磁盘计算；大补充清单仍完整参与 FA 磁盘合并。发布程序的内部强制标志遵守门槛，库测试保留小样本强制路径对照。文件错误、取消及业务计算口径保持。
- 完整口径见 `LARGE_FILE_PROCESSING.md`；回归：`cargo test --manifest-path src-tauri/Cargo.toml --lib disk_table::`、`--lib read_plan`、`--lib fa_resource_`、`--lib ordinary_mode_workers`，覆盖边界、跨工具监控、读取计划传递及大小文件联合任务。

## 2026-10-24：共享确认目录补充多个真实上级

- 同一确认身份的上级不唯一时保留 `parentAccountNames` 列表，唯一上级仍用原字段；供 FA 判断折旧费用语境。存款的角色建议、账户身份、金额及利息算法保持，普通／磁盘目录共用。边界与验收见 `LEDGER_MAPPING_UNIFICATION.md`、`FA_RUST_PARITY.md` 同日条目。

## 2026-10-24：自动映射共用成组字段、冲突补选与辅助候选

- 接入公共 Oracle Entered／Accounted、冲突后的未占用次选及有取值证据的辅助候选；规则与边界见 `LEDGER_MAPPING_UNIFICATION.md` 同日“自动映射补丁统一到公共引擎”。保留人工确认覆盖、工具业务角色范围和辅助跨表验证要求。
- 回归：`cargo test --manifest-path src-tauri/Cargo.toml --lib unified_automatic` 及本工具库测试；记录见 `artifacts/public-mapping-unification-20261024/`。本项不打包 EXE。


## 2026-10-24：读取计划与内存保护统一

存款预览／导出固定 TB＋JE 联合读取计划，并覆盖 TB 完整层级分析；监控与嵌套读表复用，指定 Sheet 不被其他表干扰。 普通计划不启用本套大文件暂停；磁盘计划保留原内存阈值、暂停恢复及取消。策略、跨工具边界和回归命令见 `LEDGER_MAPPING_UNIFICATION.md` 同日条目，worker 合成验收记录见 `build/loan-read-plan-check/`。本次不改业务计算或用户映射。

## 2026-10-24：公共双方向列完整识别

存款／FA 共用识别入口继续消费公共方向裁决，公共初判和最终组装均先识别完整双列，再按明确时点或物理前后定归属；独立第二列空白不共享第一列。大学原件普通／磁盘路径与借款、汇兑／TBJE 同件映射一致。计息、辅助验证和人工确认保持。回归及规则边界见 `LEDGER_MAPPING_UNIFICATION.md` 同日条目、`--lib direction_pair`。

## 2026-10-24：映射标记落实既有字段豁免

- 映射下拉与表型提示按现有业务门禁展示：TB 期初余额和累计发生额独立选填，期末余额至少提供一种记法；JE 净额或单侧借/贷金额即可，均为空仍拦截。未更改 Rust 豁免、单侧缺列按零处理、计息公式或导出结果。
- 公共表型仍由 Rust 下发，前端只对利息工具已有豁免作适配；借款 JE 不使用存款的单侧金额豁免。
- 回归：`npx vitest run src/ledgerForms.test.ts src/DepositInterestPage.test.ts src/DepositInterestInteractions.test.tsx src/components/MappingPanel.test.tsx`；`npm run build`。

## 2026-10-23：JE 组合科目身份与月度归集统一解析

- 存款测算的 JE 身份预扫、逐月发生额、辅助锚点验证及同码汇总口径预检共用映射感知的 `JeAccountColumns`。只有同一源列明确兼挂科目编码和名称时，调用公共 `split_combined_account_fields_ref`，将 `1002010109-人民币存款-民生银行` 作为编码 `1002010109` 与完整名称参与匹配；普通内存和磁盘路径一致。
- 保留原始单元格及上传目录、TB 确认身份和利率覆盖键。独立编码/名称列中的中文辅助后缀、纯数字辅助复合编码不全局拆分；同码异名继续按公共歧义策略细分，辅助必须经过原有完整 JE 联动验证才拆户。不修改主体、币种、日期、金额符号、取层或利息公式。
- 存款结果快照增加本次身份规则版本，旧预览不用于新版导出；库测试可显式强制磁盘 JE，并独立计入测试快照指纹。
- 回归：`cargo test --manifest-path src-tauri/Cargo.toml --lib combined_je_`、`--lib deposit_interest::`、`--lib`。原件设置 `DEPOSIT_COMBINED_REQUEST/OUTPUT_DIR` 后运行 `--lib combined_je_original_university -- --ignored --nocapture`，验证大学原始任务预览、导出复用、全部匹配行及两条路径一致。验证资料存于 `artifacts/deposit-combined-je-20261023/`；仅运行库测试，不打包应用 EXE。

## 2026-10-22：分类前发生额不再隐藏

第二步科目级发生额直接展示引擎返回的 `accountMetrics`／`entityMetrics`，不再以“已选择利息收入”为可见前提。真实0、未取得值继续分别显示0和“—”，辅助行仍不重复整科金额；分类只决定是否参与业务计算，不改变显示取数、登记方向还原或收入费用混合科目的性质。

回归：`npx vitest run src/DepositInterestInteractions.test.tsx src/DepositInterestPage.test.ts`；`npm run build`。本项为前端展示修复，未重写利息计算，也未打包EXE。

## 2026-10-22：缺失账面收入基准与零分母分别展示

- 未纳入收入科目时，结果的账面收入与差异为 `null`，保留原始金额字段和 `hasInterestIncomeAccount=false`，不认定勾稽通过；页面及Excel列示“未识别／无法比较”，状态为“待确认利息收入科目”。
- 已确认收入科目但金额为零时保留数值0与金额差异，差异率不适用。Excel公式支持改写基准后的重新计算，零分母不再由 `IFERROR` 变成0%；计算利息、收入分类和原有通过门槛不变。
- 回归：`cargo test --manifest-path src-tauri/Cargo.toml --lib three_fixes`、`--lib`；`npx vitest run src/DepositInterestInteractions.test.tsx src/DepositInterestPage.test.ts`；`npm run build`。原始07请求通过 `DEPOSIT_THREE_FIXES_PARAMS/OUTPUT` 运行 `--lib three_fixes_original -- --ignored --nocapture`，不构建应用 EXE。

## 2026-10-22：币种预检单币种不读取JE

存款和借款共用币种衔接入口：先按完整 TB 的主体科目范围判断是否需要多币种验证，无需验证时不打开 JE；真正多币种的锚点、缺失提示与口径选择不变。实现边界与回归命令见 `LEDGER_MAPPING_UNIFICATION.md` 同日条目，不改变存款建户或月均计息规则。

主动停止币种预检时保留映射、恢复按钮并显示普通状态提示，停留上传步骤；不误报币种衔接失败，也不记为通过。真正失败展示引擎中文原因，重试成功后才放行。回归：`npx vitest run src/DepositInterestInteractions.test.tsx src/components/SyncBusyDialog.test.tsx`。

## 2026-10-22：快速导出终态接收

- 桌面共用任务通道保证启动返回的任务编号先交给页面，再投递提前到达的通知；并发按编号释放，不等待业务处理完成。存款页额外按返回编号接收启动期间的最新本工具事件，拒绝其他任务／其他工具串入，终态之后不再接收该任务的迟到进度。
- 新任务清除旧进度，完成、失败、取消均恢复预览与导出按钮；成功展示文件入口。只修前端任务生命周期，不改变账户范围、计算规则、利率或底稿内容。
- 回归：`npx vitest run src/DepositInterestInteractions.test.tsx src/apiJobDelivery.test.ts src/jobStartDelivery.test.ts`；`npm run build`。包含先预览后快速导出、启动返回前失败／取消及通知乱序。

## 2026-10-22：辅助降级清单与折叠提示

- 结果新增 `summary.auxiliaryFallbackAccounts`：按本轮真实计息账户的折叠键记录主体、科目、币种、TB 辅助值与原因，仅列有辅助明细但未取得 JE 验证列的实际合并账户。复用空辅助计划时也记录范围，不依赖可能为空的 `auxiliaryGroups`，不从全局原因猜测账户。
- 界面默认折叠，展开看账户和原因；已验证拆分、未纳入计息及本来无辅助明细的行不列入。旧结果缺清单时只展示已有原因并提示重新测算；来源字段按 zod 校验。结果快照增加独立明细版本，避免复用缺清单的旧测算。
- 原辅助验证、TB 结构、科目合并、利率与月均利息公式保持；Excel 导出格式保持。回归：`cargo test --manifest-path src-tauri/Cargo.toml --lib deposit_interest:: -- --test-threads=2`；`npx vitest run src/DepositAuxiliaryNotice.test.tsx src/DepositInterestInteractions.test.tsx src/DepositInterestPage.test.ts src/DepositInterestStyles.test.ts`；`npm run build`。

## 2026-10-21：公共表头结构候选修复

自动表头识别继承公共短字段／段落筛选、后续正文及联合双层边界判据，避免说明段落仅凭业务词胜出；明确参数页要求选择数据表或手动指定表头。批量账表扫描保留同本有效 Sheet；普通与大文件入口使用一致结构规则，旧识别／结果缓存失效。各工具自身字段词表、人工指定及业务计算规则保持。接入范围、限制及回归命令见 `HEADER_DETECTION.md` 同日条目。

## 2026-10-20：人工辅助与JE续行公共修复

- 人工辅助列保留为TB结构证据，自动辅助仍按JE完整联动验证；无法关联只退回主体＋科目，不强制辅助匹配。普通JE续行补科目使用日期、凭证号、金额AND条件并排除明确合计；结果指纹引用公共JE正文版本，旧快照失效。
- 利率、月均余额及账面利息原规则保持。回归：`cargo test --manifest-path src-tauri/Cargo.toml --lib deposit_interest::`；`npx vitest run src/DepositInterestInteractions.test.tsx src/ledgerMappingAuxiliary.test.ts`。

## 2026-10-20：公共币种代码金额兼容

公共金额解析支持已知币种代码前后缀及原有负数/借贷标记，拒绝未知代码和脏文本，不换算币种；结果缓存纳入独立金额规则版本。范围及回归命令见 `LEDGER_MAPPING_UNIFICATION.md` 同日条目。

## 2026-10-19：公共TB结构规则接入核查

TB消费者统一调用公共结构引擎，结果缓存统一引用公共结构版本；JE正文不套用TB汇总剔除。适用入口、缓存与回归命令见 `LEDGER_MAPPING_UNIFICATION.md` 同日「各工具统一引用TB结构规则版本」。

## 2026-10-19：共享父子结构反向回归

- 公共账表取层补齐组尾小计阻断组首、跨组织总项、数值辅助名称缩进及单侧发生额校验；跨组织证据在上级科目树前处理空辅助重复代表，旧结果快照失效。工具自己的测算公式与人工指定行覆盖优先级不变。
- 回归命令：`cargo test --manifest-path src-tauri/Cargo.toml --lib`；真实样本反向门禁见 `LEDGER_MAPPING_UNIFICATION.md` 与 `artifacts/tb-reverse-coverage-20261019/`。

## 2026-10-19：公共完整结构与预览导出复用

- 继承公共完整组、明确级次/缩进、辅助细化和本币金额验证，不依赖 Fiscal Range 或期间列判定是否有汇总。缓存更新规则指纹；导出在测算前复用完整结果快照。
- 回归：`cargo test --manifest-path src-tauri/Cargo.toml --lib deposit_interest::`；完整样本及内存/磁盘一致性见公共结构回归。

## 2026-10-19：磁盘 TB 匹配值域取消大小拦截

- 磁盘 TB 对内存 JE 校验主体和辅助时改用共享按需磁盘值域，不再收集全列唯一摘要／金额或分配空矩阵，取消 `TABLE_DOMAIN_BUDGET`。归一化、完整值域、候选修复顺序与金额计算保持。
- JE 目录及公共 TB 关系分析的估算硬拦截同步取消，资源保护见 `LEDGER_MAPPING_UNIFICATION.md`。回归：`cargo test --manifest-path src-tauri/Cargo.toml --lib deposit_interest::`、`--lib disk_domains`。

## 2026-10-19：分类只记录，第三步统一应用

- 第二步首次准备的账户／币种行键继续用于利率编辑。人工分类及确认表回传后，停止该步骤的辅助联动、账户清单与明细衔接自动请求；保留稳定行键下的已填利率，作废旧测算展示。迟到的准备结果不能覆盖人工分类后的状态。
- “下一步”仅导航。第三步发起预览或生成底稿时，按当前分类统一检查同码明细衔接；检查失败或尚未选择口径时不启动任务。JE 科目汇总所需的新行及统一利率可直接在第三步准备、填写，不强制退回分类步骤。
- 人工分类后不向计算传入旧范围的 `auxiliaryPlan`，由原有 Rust 完整验证按当前选择重建。账户／明细角色、存款档位、逐户利率及原有计息规则保持；确认统计与进入测算门禁改按屏幕最终行角色计算，允许原自动排除的明细被手工纳入。
- 回归：`npx vitest run src/DepositInterestInteractions.test.tsx src/DepositInterestPage.test.ts src/DepositInterestLinks.test.tsx src/DepositInterestStyles.test.ts`。覆盖连续修改、行级覆盖、确认表回传、请求次数、原利率保留、第三步失败重试和两种衔接口径。

## 2026-10-18：完整 JE 目录避免全列缓存与重复汇总

- `deposit.inspect_je`（FA 复用）直接完整扫描目录所需列，跳过无关列的文本查询和全列缓存写入；目录完成后按源表、Sheet、标题、映射及显示口径缓存。二次识别无需再次汇总整张 JE。业务金额计算仍用完整来源，首条和末尾数据均保留。
- 缓存仅保存完整结果，损坏、来源改变或映射改变后重建；取消及超预算不返回完成。动态磁盘触发阈值保持不变。
- 单次识别确定磁盘路径后，预览固定为公共有界入口；不因扫描前后内存波动改走不同采样器。真实文件曾触发 281／255 行样本变化导致重读响应中的浮点数展示不同（目录与映射一致），本轮把完整响应相等纳入真实验收。
- 回归：`cargo test --manifest-path src-tauri/Cargo.toml --lib disk_catalog`；真实账表诊断沿用下述 `存款上传真实账表分段性能诊断`，记录完整响应重读相等，冷／热性能以本轮日志为准。
- 3080 相同字节的新路径副本冷读通过：235,848 行／62 列、完整目录，重传完整响应相等；未优化测试构建首次 84.453 秒、复读 1.191 秒，相比上轮 158.140／7.011 秒减少等待。整个 TB＋JE 诊断进程实测峰值工作集约 60.49 MiB，提交量峰值约 45.97 MiB；这是分批识别占用，不代表整表入内存的估计应降为同样大小。原始件与副本 SHA-256 相等。日志：`artifacts/je-catalog-shared-real-3080-final.log`、`artifacts/je-catalog-shared-results-final.json`。首次仍需完整扫描，不宣称秒开或发布优化构建耗时。

## 2026-10-18：大 XLSX 的共享文本读取复用

- FA 上传借用的 `deposit.inspect_je` 会生成完整 JE 目录。原磁盘读取器对每个共享文本单元格独立编译 SQL 并开启 SQLite 读取事务，大序时账在完成映射预览后仍长时间等待。
- 共享 XLSX 行读取器改为每张工作表复用一个只读快照和一条预编译查询，并以 8 MiB／65,536 项的有界缓存复用重复标签。新增摘要等唯一文本仍从磁盘按需读取；完整科目、主体、年度、币种、行数与首条数据的口径不变，不退回样本目录。
- 验证：`cargo test --manifest-path src-tauri/Cargo.toml --lib disk_xlsx_`；真实账表用 `DEPOSIT_TB_SAMPLE`／`DEPOSIT_JE_SAMPLE` 指定后运行 `--lib 存款上传真实账表分段性能诊断 -- --ignored --nocapture`。覆盖重复标签只查询一次、缓存淘汰、非法共享编号、富文本／空值／日期／取消与预算边界。
- 3080 原始件副本首次磁盘目录验收通过：235,848 行、62 列、完整元信息；未优化测试构建首次建缓存 158.140 秒、重复读取 7.011 秒，完整响应相等。用 `DEPOSIT_JE_EXPECTED_ROWS=235848` 运行同一诊断可锁定准确行数；正式程序没有强制预算／路径开关。构建与 worker 记录见 `artifacts/je-upload-3080-fix-report.md`。

## 2026-10-18：TB 目录、账户折叠与正式测算磁盘回放

- TB／JE 共同参与动态工作集预算。大 TB 上传先读取有界预览确定映射，再以完整磁盘正文生成科目、末级确认目录、主体科目组合、年初年末余额及利息发生指标，尾部账户不因预览截断而丢失。
- 正式账户折叠使用 `FxTbRows` 全行访问与公共 `disk_tb` 分类结果；全表符号票、整列自带符号及父名称／分类上下文在扫描阶段确定，货币资金余额、账面利息收入和存款角色继续按原算法取数。辅助锚点与明细衔接选择逐行回放，选定辅助列后的账户值再次从完整正文取回。
- 按主体币种的确认键、同码选择、两点法、利率覆盖及序时账逐月归集规则保持。第二步账户币种清单仍不打开 JE；正式 JE 本身继续走已有磁盘规范化路径。
- 边界：完整单主体／连续关系组超过公共安全预算时明确中止，不拆散父子规则；账户、候选、行级分类和最终结果元信息仍有内存成本。大旧版 XLS／ODS 要按公共读取提示转为 XLSX／CSV，不回退整表读取。
- 回归：`cargo test --manifest-path src-tauri/Cargo.toml --lib tb_disk_deposit_`（目录与指标、父分类上下文、正式测算与第二步账户键内存／磁盘等价，指定 XLSX 工作表及表头后的全部尾部账户）；常规 `--lib deposit_interest::`。

## 2026-10-18：JE 全量目录改用磁盘扫描

- 公共预算要求磁盘处理的 JE 先用有限样本确定映射，再扫描完整磁盘表，补齐全部科目、真实主体科目组合、年度和币种。确认清单不再漏掉样本后段才出现的科目，返回的总行数来自完整扫描。
- 科目展示串继续复用存款原有列拼接口径，自动角色与档位对完整科目集生成；TB 目录及金额勾稽仍沿用公共末级规则，不以样本替代正式余额表分析。
- 正式 JE 读取传入确认的 Sheet 与表头层数；月均余额还原、按币种利率和汇总选择口径不变。
- 回归：`cargo test --manifest-path src-tauri/Cargo.toml --lib disk_catalog_tests`；`cargo test --manifest-path src-tauri/Cargo.toml --lib deposit_interest::`。

## 2026-10-18：编码单列不伪造科目名称

- JE 内存／磁盘身份预扫、TB 候选与实际发生额归集的匹配键统一把纯编码视为缺名，避免参与名称消歧或缺码名称回退的虚假名称证据。原始科目展示、分类、月均计息及明确选择的同码汇总策略保持；结果快照更新规则指纹。
- 回归：`cargo test --manifest-path src-tauri/Cargo.toml --lib missing_account_name`，验证两条读取路径的空名称身份与实际月度发生额。

## 2026-10-18：跨币种总分与确认目录

- TB 计算及确认目录共用公共综合本位币去重；只剔除金额完整勾稽的综合节点，真实币种、辅助户与主体身份保留。已验证的跨币种组中，空编码辅助行可继承真实科目进入目录，是否展开仍按已有辅助联动验证决定。
- 辅助计算的公共维度视图同步去重；未能验证的综合结构继续保留。独立银行明细、不同币种平行行及既有分类规则不作合并。
- 验证命令与真实 HK 目录验收见 `LEDGER_MAPPING_UNIFICATION.md` 的 `currency_rollup_` 条目。

## 2026-10-18：单层账表不吞首条正文

| 行为 | 调整与保留边界 | 对应验证 |
| --- | --- | --- |
| 自动表头层数 | 公共读取器以编码／日期及金额正文证据排除伪双层，正文含“期初余额／公司”等关键词仍保留第一条数据；完整、采样及指定标题行后自动判断一致 | `fx::tests::header_data_keywords_do_not_turn_first_tb_je_record_into_a_header`、`fx::tests::header_data_first_record_survives_full_sampled_and_selected_header_readers` |
| 双层及人工设置 | 真正的期初／期末借贷分组继续合并；明确的人工层数设置继续优先；不改金额和科目匹配规则 | `fx::tests::header_data_guard_preserves_grouped_headers_for_selected_and_sampled_readers` |

回归及本机原始件只读验收命令见 `LEDGER_MAPPING_UNIFICATION.md` 同日条目。

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
