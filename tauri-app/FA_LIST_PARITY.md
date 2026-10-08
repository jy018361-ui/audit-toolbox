# FA List：原版与 Tauri 一比一迁移清单

2026-09-29 导出复用匹配快照（不再重新合并）：流程契约明确为「匹配之后改了输入/映射/补充清单，回第一步重新匹配；『不许硬拦』只针对匹配前的编辑」。`fa.match`（preview）在 merge 完成后把 MergeResult 落磁盘快照（`fa_merge_snapshot`，新模块）：合并行（source/匹配值/b·e 列/extra JSON）写 snappy Parquet，统计与生效参数写 JSON sidecar；快照键为文件对身份（两份主文件规范路径＋大小＋修改时间），指纹为合并相关参数白名单（路径/Sheet/标题行/键位/映射/原值折旧直选/去空格大小写/补充清单，含补充文件身份）——期初期末表本体不进快照，加载时经 `fa_table_cache` 原路取回并逐位比对表头。`fa.export` 先取快照：命中即复用（跳过读表与配对），指纹不一致只在进度与完成消息提示「建议重新匹配」、不回退重算（保证导出套表与第一步统计同源，生效参数回放匹配时取值，表日/输出路径等导出阶段设置仍用当前值）；无快照（首次、换了文件对、文件被改动、快照损坏）才现场合并兜底并刷新快照。导出完成消息附各阶段真实耗时（复用/合并｜税法年限分析｜生成套表），匹配完成消息附匹配耗时。旧断言「导出按当前映射重算」改为「不重新匹配沿用上次匹配结果、重新匹配后采用新键位/映射」（`export_reuses_last_match_until_user_rematches`）。`fa.dep_export`/`fa.policy_export` 仍各自现算，未接快照。回归：`cargo test --manifest-path src-tauri/Cargo.toml --lib fa:: fa_merge_snapshot`；前端 `npx vitest run src/FaPageDesign.test.ts src/faListUi.test.ts`（「结果待重算」黄条文案同步为新语义）。

2026-09-29 前缀恒定误判纠正（公司键回归组合）：实测 27 万行期末清单（IT 账套）前 197 行恰好全是占 91% 的大主体 000000，全列实有 9 家主体且与期初 5 家完全重叠——前缀数据被 `column_is_constant` 误判「公司列恒定→无区分度→不进组合键」，上午的键位对齐又随之撤掉期初的「公司」，结果两侧公司列都不再挂资产ID（用户实测发现）。修复两处：①恒定判定只在整表数据下结论，前缀表（`rows.len() < row_count`）一律返回"未知"——公司列照常进组合，交给逐位值域校验用真实数据裁决（前缀互查未命中会定向抽列补深，一次性代价入缓存）；②`is_company_id_header` 补认「公司编码/公司代码/公司id/companycode/companyid」编码形态，期末侧的「公司编码」列现在能被选为公司键成员（与期初「公司」同为编码值域，配对天然对上；名称形态列头若被误占位，逐位校验会按值域纠正到编码列）。真机验收（FA_LIVE_INSPECT 活体测试）：建议键期初 [FA编号, 资产说明, 公司]、期末 [资产编码, 资产名称, 公司编码]，三对全部命中，`fa.key_check` 连续两次 0.0s；LLM 复核不背此锅——复核样例只取开头数行，本例开头全是同一主体，模型看不到多主体证据，该判断属于本地数据规则职责。回归：`cargo test --manifest-path src-tauri/Cargo.toml --lib fa:: fa_sheet_pick`（新增 `prefix_constant_company_column_still_joins_composite_key`）。

2026-09-29 名称词表与键位对齐（真实双清单验收收尾）：实测期初清单的名称列叫「资产说明」而非「资产名称/资产描述」，本地词表全部不沾导致该角色恒空、LLM 复核也无本地候选可佐证。名称角色词表补入「资产说明」，`looks_like_name` 同步纳入「说明」一族（描述类散文列同时失去键候选资格，与「描述」同口径）。组合键成员（名称/公司列）按本侧条件独立加入导致两侧键数不等——期初多主体（公司列 5 个值）会补公司键、期末单主体（公司列恒定）不补，期初的「公司」悬成单侧键位，徽章恒为未命中；`fa.inspect` 建议键现按较短一侧对齐（`align_key_members`），多出的尾部成员直接撤掉、首键（主编号）承载选列建议永不裁剪，随后照常走逐位预碰撞（能纠正则纠正、双侧无据则撤键）。真机验收（两份真实清单，FA_LIVE_INSPECT 活体测试）：期初建议键回到 [FA编号, 资产说明]、期末 [资产编码, 资产名称]，两对全部命中，悬空公司键消失；`fa.key_check` 连续两次 0.0s（列值缓存生效；新配对首验的一次性定向抽列约 15s 已落缓存）。回归：`cargo test --manifest-path src-tauri/Cargo.toml --lib fa:: fa_sheet_pick`（新增 `key_alignment_trims_dangling_composite_members`）。

2026-09-29 键列资格审查（序号/恒定列防线）：实测 153MB 期末清单曾把「序号」纠正成资产ID、单主体文件的恒定「公司」列挂着必绿的命中徽章——根因是预碰撞校验只做"值域互查"（防张冠李戴），防不了"两列都是劣质键但值恰好互含"：序数列（值≈行号 1..N）在唯一度/覆盖度打分里形似完美 ID 且几乎包含一切整数，恒定列与恒定列互击即绿。修复三处：①`is_forbidden_id` 增列「序号」「行号」；②键建议（`pick_match_header`）与纠正候选（`find_column_containing`）一律排除**序数形态列**（样本与"首值＋位置偏移"重合≥80% 即判行号列）与**恒定列**（非空样本仅一个值）；③组合键的公司列成员只在多主体（值有变化）时保留，单主体恒定公司列不再进键。多主体文件（如科技FA存量清单含 5 个公司段）的公司键位照旧保留防跨主体串号。代价说明：极小型账套若资产编号恰为连续整数会被误判为序号列，此类文件交由人工/LLM 复核兜底。回归：`cargo test --manifest-path src-tauri/Cargo.toml --lib fa::`（新增序数/恒定防线两组断言，`资产序号` 不再可被兜底层级选中）；真机验收 `FA_LIVE_INSPECT="期初,期末" cargo test --manifest-path src-tauri/Cargo.toml --lib live_inspect_avoids -- --ignored --nocapture`（实测两份真实清单建议键回到 FA编号/资产编码，序号出局）。

2026-09-29 交互读取前缀化（自动选表轻量化二期）：`fa.inspect`／`fa.key_check`／`fa.supplement_inspect`／LLM 复核等交互入口不再整表物化——xlsx/xlsm 经 `fa_sheet_pick::load_prefix_table` 只读胜出表前 200 行（表头探测窗口 20 行＋样例余量），行数规模取工作表声明值；xls/ods/前缀不可用时原路整表。需要全量数据的判断改为按需补深：匹配键预碰撞的成员判断先查前缀行，未命中且确属前缀表时**定向抽列**（一次流式解压只保留目标列值，其余即读即弃，共享字符串表按文件身份单份缓存）；建议键校验只信"全部直接命中且未动一键"的前缀结论，出现未命中／纠正／撤键时退回整表重跑同一套判键逻辑并把整表写进复核缓存，后续手工调键与 LLM 复核以全量为准。`fa.key_check` 只读不改键，前缀＋定向抽列即可给出可靠的命中徽章。补充清单键推断的参照表键列同样定向补深，补不动退整表，证明口径不变（补充表自身取头/中/尾三样本的"中/尾"按前缀内位置取，样本值本身为真实数据）。前缀结构表按工作簿身份＋表名＋标题行落磁盘缓存（`.sheet` 扩展名随既有清扫），同一文件再次打开连解压都省。合并/导出 worker 仍整表读取（本就需要全量且有进度）。真机基准（debug 构建）：153MB 期末清单 inspect 首开 142.7s→**1.8s**、复开→**0.0s**；39MB 期初清单 42.2s→**0.9s**。回归：`cargo test --manifest-path src-tauri/Cargo.toml --lib fa_sheet_pick fa:: fa_subtools`；真机计时用 `FA_AUTO_SHEET_BENCH=<目录> cargo test --manifest-path src-tauri/Cargo.toml --lib fa_sheet_pick -- --ignored --nocapture`。

2026-09-29 自动选表轻量化：`fa.load_table` 自动模式不再把每张可见工作表整表物化后打分，改为三级退让——选表记事（键为工作簿身份：规范路径＋大小＋修改时间＋标题行，落在看账缓存目录 `fa/v1`，扩展名 `.sheet` 随既有缓存清扫淘汰）→ xlsx/xlsm 前缀轻量打分（每表只从 zip 流式解出前 20 行，与 `detect_header` 的扫描窗口对齐；判前缀与判整表共用 `fa_sheet_pick::auto_sheet_judge` 同一份打分，选表结论不变）→ 记事与前缀都走不通（xls/ods、zip 结构不认识、没有任何表认出角色）时退回原整表扫描兜底。胜出表仍整表读取：`fa.inspect` 的资产ID预碰撞校验需要全列真实数据，不在本轮缩水。真机基准（debug 构建，153MB 期末清单）：选表瞬时完成并写入记事，耗时大头转为胜出表自身整表读取（冷启约 173s/热启约 143s；release 构建、两文件并行读取与整表磁盘缓存列为后续项）。回归：`cargo test --manifest-path src-tauri/Cargo.toml --lib fa_sheet_pick fa::`；真机计时用 `FA_AUTO_SHEET_BENCH=<目录> cargo test --manifest-path src-tauri/Cargo.toml --lib fa_sheet_pick -- --ignored --nocapture`。

2026-09-29 资产ID预碰撞校验：`fa.inspect` 对自动建议出的组合键逐列取一个非空样本，经轻量归一（去空格、去前导单引号、数字规范化、ASCII 小写）与对方表做成员碰撞；未命中先在对方全表找同值列静默纠正（优先非禁列、再取最靠左，已占用的键列除外），再反向纠正本侧，双侧均无则撤掉该键位；纠正只作用于自动建议，`fa.key_check` 供手工调整后只刷新“已命中/未命中”徽章、不改写用户选择。合并连接比较与预检共用同一归一函数（“文本001009”可与“数字1009”连接），展示列仍写原值。寿命本地词表补入“折旧年限”；LLM 复核提示词约定可选角色仅在唯一可信候选列时才给补齐建议；预览标题旁“选填未映射”黄条移除（必填“尚未映射”保留）。回归：`cargo test --manifest-path src-tauri/Cargo.toml --lib fa::`、`npx vitest run src/faListUi.test.ts src/FaPageDesign.test.ts`。

2026-09-28 补充清单入口调整：取消“仅期末行数大于零＋期末映射新增方式”触发的整份期末表预填与第二步自动跳转。匹配后保留第一步统计，由用户主动选择补充清单或直接导出；手工补充文件、字段映射及期末表自带的新增方式／新增日期导出逻辑继续保留。回归：`npx vitest run src/faListUi.test.ts src/FaPageDesign.test.ts`、`npx tsc -b`。

2026-09-28 两期清单流程修正：人工修改映射后保留旧统计供对照，允许继续补充或直接导出；导出使用当前输入、匹配键及映射重新合并，不再要求用户先重复点击开始匹配。此前“旧结果不可直接导出”的口径仍适用于 TB＋JE 模式；两期清单按当前配置重算导出。公司名称等表头直接自动映射为现有资产 ID，不增加独立角色、输出列或重复编号前提。未标注处置方式的折旧汇总、已知公式结果缓存、LLM 复核缓存与输出精简详见 FA_RUST_PARITY.md 的同日记录。

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

2026-09-27 类别代码列与列头映射修复：字段映射的“资产类别”现在按旧版
`pick_fa_category_column` 的值形态嗅探挑选——列名命中数值字段黑名单、或样例值
多数像 `Y110` 这类短代码的列直接跳过，让位给“资产类型描述”等分类文本列
（此前只按列名与列序取首个命中，`2025固定资产卡片02` 样例因此把类别映到
A 列代码列）。LLM 复核指令同步硬化：已映射类别列样例为短代码且存在文本
类别列时必须 replace、不得 keep；本地预警新增单文件内值形态检测——两期都
错映到同一代码列时跨期重叠检测失效，该检测兜底注入 suspectMappings。
前端列头映射下拉改为“选择只做加法”：在已映射列上勾选资产ID保留原角色
形成 ID＋名称双角色，只有“—”清空本列全部角色；此前勾选资产ID会顶掉
资产名称。补充清单列头下拉同口径。回归命令：
`cargo test --manifest-path src-tauri/Cargo.toml --lib fa::`、
`npx vitest run src/faListUi.test.ts src/FaPageDesign.test.ts`。

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
- [x] 三阶段向导，匹配后由用户选择补充清单或直接导出
- [ ] 不再保留原版“文件 2 已识别新增字段时自动进入补充步骤”与期末整表预填新增清单的行为（2026-09-28 按用户要求移除）
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
