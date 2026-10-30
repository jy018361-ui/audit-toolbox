## 2026-10-30 · 说话人发言内容占比

- 根据原始转写计算内容占比（有效Unicode字母／数字字符数，忽略时间、标签、标点、空白），在两版结果正文中的编号或用户姓名之后显示，姓名输入区域不显示；不按纪要中标签出现次数统计，不等同发言时长或声纹识别。百分比最多一位小数，四舍五入可能存在尾差；极小非零占比显示小于0.1%，非独占的极大占比不冒报100%。
- 预读复用原有授权转写接口，不修改原始文件、不增加模型调用；未知归属内容计入分母并提示。无文件、读取失败、无有效说话人内容时提示不可用，不编造0%或100%。转写结果按会议／路径关联并丢弃迟到读取；切版本、改姓名、编辑摘要不改变占比。富文本正文及表格带占比，复制及邮件同样带占比；保存时身份标记仍还原编号来源，不把派生百分比重复追加到源稿。手工改写身份标记仍尊重用户正文，不反向替换普通同名文字。
- 验证：`npx vitest run src/meetingSpeakerShares.test.ts src/MeetingMinutesPage.test.tsx src/meetingMinutesEditing.test.ts src/meetingMinutesAutoSave.test.ts src/meetingMinutesEditApi.test.ts src/meetingMinutesFormat.test.tsx`、`npm run build`、`node scripts/verify_meeting_speaker_shares_ui.cjs`；仅使用本地合成数据，正文显示、姓名替换／清空、富文本保存去重及浏览器验收记录在 `artifacts/meeting-speaker-shares-20261030/`。未改原生转写和录音流水线、未更新安装版。

## 2026-10-30 · 手动与自动停录对照诊断

- 用户反馈：正式版132中手动「停止并生成纪要」易出现短录音、自动结束正常；当前不能从旧summary确定点击前已断录还是点击后截断，不能把相关性写成已证实因果。
- 核对：手动入口先等待原生 `meeting_record_stop` 返回再生成，自动入口同样先封盘再启动任务；两者共用 `meeting_record::finalize`，停止后等待全部采集线程退出再混音。新增实际WAV回归模拟停止时缓冲仍待写入，手动／自动均需保留全部样本。
- 诊断增强：明确区分manual／automatic／app_exit，在发停止标记之前写入 `recording-stop-request.json`，保存请求时间、开启时长、各轨已落盘字节和编译版本；最终summary保留同一stopContext及版本。字节数允许有尚未落盘的缓冲，不能当作有效语音时长；诊断写入失败不阻止停录。原始音轨保留，不重试上传或改变停止行为。
- 验证：`cargo --config profile.test.package.audit-toolbox.debug=0 test --lib meeting_`；合成样本覆盖两个入口的线程等待、封盘后完整混音与停止前证据，原生会议模块定向回归通过（日志：`artifacts/meeting-stop-comparison-20261030/rust-tests.log`）。此项补充诊断及回归，不宣称已在用户电脑复现或修复手动按钮特有的截断；自动重连修复仍需包含该代码的新版本验收。

## 2026-10-29 · 详细度与重新生成入口

- 详细度旁「生成纪要」的来源优先级为：已导入音视频、当前会议转写稿、当前会议保留录音。存在上传时不误用当前阅读的其他会议；无上传时允许自动录制结束后的结果或所选历史会议按新的详细度重新生成两版。有转写稿走 `meeting.summarize`，不再发起转写；仅有Markdown而没有转写或录音时仍禁用。
- 页面显示来源提示，生成中提示等待；录制、任务运行、录音操作或历史结果读取期间禁止重复启动。未收到新任务事件的启动失败恢复原会议与选择，方便原地重试，不让迟到结果覆盖新的会议选择。
- 显式浏览器演示模式增加合成的 `meeting.generate`／`meeting.summarize` 事件回放和正确toolId，允许在1420预览体验简要／标准／详细切换；普通浏览器模式仍禁用真实本机操作，演示不调用云端或处理用户文件。
- 验证：`npx vitest run src/MeetingMinutesPage.test.tsx src/components/MeetingWatch.test.tsx src/preview/demoRegistry.test.ts src/apiJobDelivery.test.ts`、`npm run build`、`node scripts/verify_meeting_regeneration_ui.cjs`。覆盖自动完成后无上传、上传优先、历史录音回退、无来源、运行中／录制中禁用、启动失败及重复点击；浏览器检查无上传选择两档重出、再次生成、提示及无外网请求。记录在 `artifacts/meeting-regenerate-20261029/`。不改原生生成流水线，未调用真实服务或更新安装版。

## 2026-10-29 · 提醒精简与通知点击

- 取消检测到会议、录音开始成功、录音保存成功及开录／结束逐条质量桌面通知；保留录音询问窗，失败时才降级应用内询问。录音／保存状态共用胶囊位置；会议进度默认收起、可主动展开，不影响其他工具。
- 完成或失败仅在主窗口非前台时通知，同任务终态去重，用户主动取消不通知；会议页直接展示结果，其他页面保留结果浮卡。录音收尾／任务启动关键故障后台提醒一次。质量诊断仍保留在页面与文件，设备重连不新增通知。
- 当前通知插件 Windows 桌面实现无点击派发，新增独立原生 Toast 命令，复用同一 Windows 通知库。点击恢复主窗口并发送原任务编号；前端已收到的事件优先，重载后按历史 jobId 查询对应会议。路径访问继续经原历史和 AllowedPaths 授权，不从通知输入恢复文件权限。
- 测试：`npx vitest run src/components/MeetingWatch.test.tsx src/components/JobDialog.test.tsx src/MeetingMinutesPage.test.tsx` 覆盖去重、前台静默、取消静默、质量不通知、旧通知定位原任务、会议页不重复浮卡、默认收起和普通工具行为；`npm run build`；原生会议模块定向编译回归均通过（日志：`artifacts/meeting-notifications-20261029/rust-tests.log`）。尚未进行已安装 Windows 程序真实 Toast 点击验收；用户完全退出进程后的旧通知冷启动激活不在本次实现内。未上传用户会议或更新安装包。

## 2026-10-29 · 录音设备失效与无数据恢复

- 用户诊断：16:30:28 开始，麦克风 159969 样本（约 10 秒）后报 Windows 0x88890004；系统声 162529 样本（约 10.16 秒），近乎无声。旧采集线程遇错直接退出、无数据不自检，初始化成功不代表全程正常。文件未含结束时间，不能从中推断整场实际长度或设备具体切换原因。
- 设备读取错误后停止并释放旧 WASAPI 流，每两秒重新按 Teams 活跃设备选择策略初始化，直到成功或用户停止；写盘失败不按设备错误重试。连续十秒没有数据包也重新初始化（正常静音包不触发）。重连复用唯一 WAV writer，保留前段，以单调时间补零表达断录位置；补零不能恢复丢失声音。重连日志分轨追加时间、错误及新来源；实时状态及结束警告保留诊断，summary 新增 endedAt／wallDurationSec。
- 验证：`cargo --config profile.test.package.audit-toolbox.debug=0 test --lib meeting_record::tests::`。本地合成 WAV 检查前段保留、中断时间轴、静音标志、停止中断重试和追加日志；未在用户电脑复现驱动失效或验证设备恢复效果，不宣称找回丢失音频。未上传用户录音或替换安装包。

# 会议纪要原生功能验收矩阵

## 2026-10-29 · 原位编辑、自动保存与时间版阅读调整（当前行为）

- 此节替代下方手动编辑／保存入口及旧的时间轴、邮件标题规则。正文直接编辑标题、段落、列表和表格，无编辑或保存按钮；读取本身不重写纪要。中文输入法在组合完成后同步，输入后450ms合并自动保存，失焦或切换工具／版本时立即提交；每个文件的串行队列沿用上次成功修订，保存期间的新输入继续作为下一修订，不被迟到响应覆盖。
- 姓名修改自动应用并保存两版，未加载版本按确切授权路径补读；仅保存修改过的源稿／姓名。原位HTML通过受控编号标记保留姓名来源，手工改写该处时转为普通文字；不会把正文原有姓名反替换为编号。富文本转回Markdown保留标题、列表、表格、加粗等结构；粘贴滤除脚本、外部图片与不可信身份标记。文件错误／外部修订冲突保留草稿、可重试或确认后重新载入；浏览器和无文件正文只保留本次页面修改，不伪造持久保存。
- 时间版按发生顺序保留阶段和议题，去掉录音相对时间戳／时间区间，保留会议事实中的实际时间和截止日期；旧结果界面／复制／邮件同步清理，新生成提示词与原生返回正文也清理。原始转写稿保留时间戳。
- 邮件正文一级标题去掉「（按内容）／（按时间）」，主题格式为「主题_会议纪要」。同一排版器和当前正文、姓名对应继续用于复制／邮件，所有变化无需用户先保存。
- 验证：`npx vitest run src/meetingMinutesAutoSave.test.ts src/meetingMinutesEditing.test.ts src/MeetingMinutesPage.test.tsx src/meetingMinutesFormat.test.tsx`、`npm test`、`npm run build`、从 `src-tauri` 执行 `cargo test --lib meeting_`。`scripts/verify_meeting_edit_ui.cjs` 以合成文件在真实浏览器直接编辑正文／表格、自动保存失败重试、跨版本和重开、姓名修改及隔离；`scripts/verify_meeting_mail_ui.cjs` 核对复制、邮件、主题和无时间轴。记录在 `artifacts/meeting-inline-20261029/`。未操作真实会议或调用云端，未替换安装版。

## 2026-10-29 · 带格式复制与 Outlook 邮件草稿

- 共用 `meetingMinutesFormat.tsx` 将当前替换姓名后的纪要渲染为带内联样式的 HTML；默认微软雅黑（Microsoft YaHei），保留标题层级、加粗、列表、表格边框和浅色表头。HTML 原文不执行，图片与外链不加载。纯文本副本保留可读段落与制表分栏，不携带 Markdown 分隔符。
- 「复制正文」优先通过 ClipboardItem 同时写入 `text/html`／`text/plain`，嵌入浏览器不支持时尝试 copy 事件；最终只能复制纯文本时明确提示。原始转写保持原文复制。复制和草稿均采用当前版本及尚未保存的编辑／姓名，不读取过时文件，不发起ASR或LLM任务。
- 新增按钮「生成邮件草稿」，紧邻「打开输出文件夹」。主题取当前正文一级标题，移除末尾按内容／按时间标签，追加「会议纪要」，避免重复后缀。生成期间阻止重复，失败可重试，切换版本不展示前一版的迟到提示。
- `meeting_create_mail_draft` 是单独的原生命令，验证标题与HTML边界后在专用STA线程创建经典Outlook的MailItem，设置HTML格式、Subject和HTMLBody，先Save再Display。接口不含收件人、附件、查邮箱或Send行为。保存成功但Display失败仍报告草稿已存在，避免用户误以为未创建；无经典版Outlook或账户不可用时明确报错，新版Outlook不支持此COM接口。
- 验证命令：`npx vitest run src/meetingMinutesFormat.test.tsx src/MeetingMinutesPage.test.tsx src/meetingMinutesEditApi.test.ts`、`npm test`、`npm run build`、从 `src-tauri` 运行 `cargo test --lib meeting_`。`node scripts/generate_meeting_mail_sample.cjs` 用真实排版器生成合成HTML／EML；`node scripts/verify_meeting_mail_ui.cjs` 检查1440/900/390宽度的双格式剪贴板数据、姓名替换、正文与草稿一致、版本选择及按钮位置。原生可选测试 `meeting_mail_outlook_sample_file -- --ignored` 只创建合成MailItem并SaveAs到明确指定的MSG文件，不保存到邮箱文件夹或发送；检查主题、Outlook HTML属性、存储形式及空收件人。MSG可能将HTML封装为压缩RTF，不以缺少独立HTML属性流判定格式丢失。
- 报告与合成样例：`artifacts/meeting-mail-20261029/`。未读取真实邮箱或会议、未发送邮件、未打包安装版；真实收件端的最终字体仍取决于是否安装微软雅黑。

## 2026-10-29 · 正文编辑与本次会议姓名对应

- 会议结果提供「编辑正文」：内容版、时间版和单版旧纪要可修改标题、段落及表格，保存后使用同一 Markdown 文件；复制使用当前修改正文。草稿按确切文件／版本隔离，切换工具、版本或历史会议不会串用；后台旧任务快照不覆盖已修改内容。未落盘的内联正文仍可编辑和复制，不把浏览器预览显示为本机保存。
- 结果开头根据实际编号提供姓名输入区；回车或移出输入框后即时应用到两版纪要，未填编号保持原样。仅替换完整「说话人N」标签，避免1误替换10；姓名作为 Markdown 字面文本转义，不改变普通正文里已有的同名文字。清空恢复编号，修改姓名可再次投影；编辑源稿保留编号，预览和文件呈现姓名。
- 「保存修改」保存当前版本；「保存姓名及全部修改」依次保存全部已有文件的版本，并保留各版本草稿。部分保存失败明确显示并可重试，成功版本按新修订继续保存。原始转写稿始终保留原文，不重新转写或调用LLM，不从姓名输入推断其他会议的身份。
- 新增 `meeting_save_minutes`，使用既有 `AllowedPaths` 和原生 Markdown/UTF-8/2MB边界，选中文件仍只授权自身。保存前比对编辑时文件正文；写入唯一同目录临时文件并同步后再替换，失败清理临时文件并保留旧文件。外部修订冲突保留草稿并提示重新载入；载入替换未保存草稿需用户确认。
- SQLite `meeting_documents` 保留按确切规范文件路径索引的编号源稿、已写入正文和姓名对应。重启后文件正文仍匹配已存修订才使用源稿重新投影，支持再次改名；外部改写使该溯源失效，不对普通姓名做反向全文替换。元数据与文件保存失败时不报告成功；无新增语音模型／运行库、声纹登记或跨会议匹配。
- 验证：`npx vitest run src/MeetingMinutesPage.test.tsx src/meetingMinutesEditApi.test.ts src/components/MeetingWatch.test.tsx src/AppNavigationSettings.test.tsx`、`npm test`、`npm run build`、从 `src-tauri` 运行 `cargo test --lib meeting_` 及开发构建均通过。原生回归覆盖实际文件替换、占用失败保留原文、修订冲突、原稿与另一版本不变、确切文件授权、姓名转义、跨重启溯源及会议隔离；`node scripts/verify_meeting_edit_ui.cjs` 用隔离模拟文件在1440/900/390宽度检查编辑、版本草稿、保存失败重试、双版保存及重开、改名和原稿不变。开发EXE运行 `scripts/verify_meeting_vocabulary_worker.py` 通过合成转写稿的独立worker冒烟检查。记录位于 `artifacts/meeting-edit-20261029/`。未调用云端，未读取真实会议或更新安装版。

## 2026-10-28 · 可维护的专有词库

- 含义确认：按用户确认写入 FIC＝现场负责人、FDE＝现场部署工程师、EDC／CSDC＝安永交付中心、CCP＝PBC 收发存管理门户、SWP＝标准审计工作底稿、A3＝试算平衡表、ARP＝分析性复核、TRDA＝安永数字化团队、TR＝TRDA 简称、UT＝工时利用率、skywind＝天风，并写入此前讨论且获确认的底稿、分录、复核及风险术语解释。AI 保留人工智能／审计指令的语境歧义，PMTE 解释为 PM、TE 两项连读；PIFEE、EYC、CA、ca tie 等未确认项保持空白，不补造全称。所有标准词条保留，跨条目的同义关系在含义中注明，skywind 补充「天风」别名用于识别。
- 旧词库升级：一次性 `confirmed-definitions-20261028-v1` 迁移，仅给仍符合旧初始值（原拼写、行业分类、启用、无别名、空解释）的现存默认词条补充含义。改名、人工解释、改分类、别名及停用项保持原值，不重建已删除项；新别名冲突时只补含义，达到词库总容量限制时跳过该条补充。初始化、回填和迁移标记同一事务完成，后续清空解释或删除别名不再自动补回。首次安装直接载入带解释的默认配置。回归覆盖旧库重开、重复启动、编辑保护、别名冲突、容量边界及实际纪要／热词快照。

- 入口修正：侧栏网格和分类组使用可收缩轨道，展开按钮保留固定宽度，避免长工具名把箭头推入滚动条裁切范围。进入会议纪要页自动展开二级词库菜单，支持手动收起。浏览器验收必须从会议主页面实际点击进入，检查按钮边界和点击命中，不能只用词库直达路由验证。

- 入口仅放在侧栏「会议纪要助手」的二级菜单「专有词库」，独立路由 `/tools/meeting_minutes/vocabulary`；会议主界面维持现有布局。词库按公司／行业／其他三个区域展示紧凑词块，名称、简称和含义均可搜索；点击词块弹窗查看、编辑、启停或确认删除，新增时可选择分类。
- `assets/meeting/vocabulary-defaults.json` 编译期内嵌用户提供的初始词，保持原拼写、重复 TRDA 去重，初始分类为行业、默认启用；仅写入已讨论并获用户确认的解释。完整词条仅首次创建 `meeting_vocabulary` 表时导入；后续仅执行上述一次性解释补充，不覆盖人工修改，不补回已删除项。词库与 `settings` 独立，避免设置页自动保存覆盖；增删改在 SQLite 事务及同一连接锁下执行。
- 词条包含标准名称、分类、最多五个简称、含义和启用状态。前后端校验输入；名称／简称去除首尾空格，不区分大小写检查跨词条重名与简称冲突；词库容量与总内容有界，失败不覆盖当前内容。保存失败保留弹窗草稿，预览模式不伪造本机保存。
- 持久库 `data/audit-toolbox.db` 与缓存根目录分离；手动清缓存／周期清缓存均只扫描缓存目录，词库不纳入清理。同通道正常升级复用持久库并保留人工增删改；正式版与 Dev 版遵循原有独立数据目录规则。删除应用数据目录会丢失词库。路径隔离、数据库重开及删除默认词后不补回有回归保护。
- `job_start_inner` 为所有 `meeting.*` 任务注入 `__meetingVocabulary` 快照；后台自动生成、手动停止、导入及转写稿重出共用。任务运行中修改词库仅影响之后启动的任务。worker 读取快照，不访问 Tauri state；停用词条不进入转写热词或纪要上下文。
- Qwen ASR Flash 3.0／3.1 的 HTTP 与异步文件转写请求通过 `parameters.vocabulary` 传入标准名和简称（普通权重 4）；长录音每段沿用同一份热词。不含非 ASCII 字符的词最多七个空格分词，否则最多十五个字符，超长公司名称仍保留于纪要理解上下文。Paraformer、realtime 和未知兼容模型不发送未核对的热词参数；本次未实现 Paraformer 云端预编译词表的创建／更新。
- 两版纪要均收到同一份启用词条及含义；作为参考数据加入用户正文，系统提示词要求仅按明确上下文规范名称、不强替换歧义简称、不将词库当作会议事实或任务指令。词条中出现 `json` 不会改写系统提示词或触发公共请求器的结构化输出模式。保留转写原稿，不做全局字符串替换，不重写已有纪要。提示词约束不能代替真实会议内容复核。
- 验证命令：`npx vitest run src/MeetingVocabularyPage.test.tsx src/meetingVocabularyApi.test.ts src/AppNavigationSettings.test.tsx src/MeetingMinutesPage.test.tsx`、`npm run build`、`cargo test --manifest-path src-tauri/Cargo.toml --lib meeting_`、`cargo test --manifest-path src-tauri/Cargo.toml --lib bailian_`。本地 HTTP 验证通用及套餐转写的实际热词请求与多段传递；无真实云端调用。`node scripts/verify_meeting_vocabulary_ui.cjs` 使用隔离模拟 IPC，检查宽窄窗口、分组词块、弹窗增删改及主题；`python scripts/verify_meeting_vocabulary_worker.py --exe <EXE路径>` 用合成转写稿验证独立 worker 的快照和双版错误路径，不读凭据或访问云端。构建日志、浏览器截图和检查结果位于 `artifacts/meeting-vocabulary-20261028/`。未重新打包或替换安装版，未用真实录音评价识别准确率提升。

会议纪要是 Rust 原生功能，不依赖上一级 Python 引擎。此表记录当前行为和验证边界，不表示全部 Teams 版本与设备组合均经真机验收。

| 行为 | Rust / 前端实现 | 回归与边界 |
| --- | --- | --- |
| Teams 日志开始/结束 | `meeting_watch.rs` 跟踪全部 SlimCore 日志，按标记时间合并；首轮推断当前状态 | `meeting_watch::tests::`；不保证 Teams 始终写这些非公开日志 |
| 日志缺失时兜底 | `meeting_audio.rs` 按映像名、进程创建时间与 Teams 父子关系校验音频归属；Teams 采集和播放会话同时持续活跃 3 秒才开始；双向流都停止 10 秒才结束；日志与音频每轮同步当前会态，可交叉接管结束检测 | 覆盖无关输入法／WebView、父 PID 复用、枚举后 PID 变化、身份不可读取、单向会话和防抖重置；含日志开始后麦克风始终关闭、音频开始后仅日志结束；静音看流状态，不看音量；枚举失败不作为结束信号 |
| 录音前询问 | `MeetingWatch.tsx` 订阅后读取快照，独立小窗隐藏复用；退会在 Rust 与前端隐藏，并关闭降级弹窗 | `MeetingWatch.test.tsx`、`MeetingAskWindow.test.tsx`；覆盖串行显示／隐藏、拒绝和关闭不等待回传、旧请求不污染下一场；预加入麦克风预览或 Teams 设备测试可能触发启发式询问；不会自动同意录音 |
| 会议系统声 | `meeting_record.rs` 优先按 Teams 活跃播放会话选实际播放设备回环，设备不可用才回退 Teams 进程树，最后默认通信／播放设备；备用来源明确提醒 | 来源优先级及失败回退回归；设备回环会包含同一设备上其他应用的声音，开录提醒；多账户、多个独立 Teams 根进程及录音中途切换设备尚未全部验收 |
| 麦克风 | 优先选 Teams 活跃采集会话设备；其次音量峰值；最终默认通信麦克风并告警 | 与 Windows 会话共用归属逻辑；设备临时切换后自动重连尚未实现 |
| 录音质量提示 | 初始来源和警告写 `recording-start.json`，最终成品、警告和系统声／麦克风／混音的 `audioStats` 写 `recording-summary.json`；页面提醒不会被转写启动清掉 | `MeetingMinutesPage.test.tsx`、`meeting_record::tests::`；统计含样本数、非零样本数、归一化峰值和 RMS；不把初始化成功等同采集有声，RMS 体检仍只是启发式 |
| 本地音视频解码 | `meeting_media.rs` 使用 Windows Media Foundation Source Reader，只选择首条音轨，转为临时 16 位 PCM WAV 后交给通用或套餐转写；原生录音／已有 16 位 PCM WAV 原样复用 | `meeting_minutes::media::tests::`；必跑合成 H.264＋AAC 的 MP4/MOV、WMV＋WMA、MJPEG＋PCM 的 AVI 及 MP3/M4A/AAC；WebM（VP8＋Opus）与 FLAC 独立 ignored 测试，仅在已安装对应媒体解码器的系统显式执行；Windows 解码能力仍依赖系统可用媒体组件，特殊编码或受保护文件友好报错，不宣称任意编码都兼容；应用运行／测试不依赖 FFmpeg、Python 或额外 EXE |
| 音轨隐私、取消与来源 | 视频画面不上传；逐音频缓冲检查取消，结束／失败／取消时清理本任务 WAV 与空临时目录；结果、历史、输出目录均继续关联用户原文件，不登记临时音轨 | 合成样例断言原文件字节不变、临时路径清理；无音轨、损坏文件、预先取消和已写入部分音轨后的中途取消均本地报中文错误并验证清理，无真实云调用；强制结束进程后的临时文件回收未覆盖 |
| 纯静音上传拦截 | `meeting.generate` 在读取密钥和调用云端之前检查解码后的 16 位 PCM WAV，全零／空数据直接中文报错，保留原文件；通用和套餐通道共用 | `meeting_minutes::tests::`、`meeting_record::tests::`；低音量、包含非零数据不据此拦截，不宣称可判断是否有人声；解码失败不再向套餐入口直接传入不兼容压缩文件 |
| 百炼文件转写 | qwen-audio-3.1-asr-flash-filetrans 保留异步上传／提交、以 GET 查询任务并开启说话人分离；HTTP 信封读取 `output.results`（兼容扁平快照）；提取结果地址后下载文本 | `bailian_asr::tests::`；真实结构成功、子文件失败、空结果与缺字段分别回归；不再把缺字段误报为无人声 |
| 原生 worker 音视频验收 | `scripts/verify_meeting_media_workers.py --exe` 启动指定 EXE 的 `--rust-table-worker`，MP4/WMV/AVI 分别经过两条转写通道；在原生解码后故意以无效地址结束 | 验证已读取声音、返回对应通道 URL 配置错误、原文件字节不变、独立 TEMP 中无残留；另验无音轨、损坏、预先取消；通用和套餐的配置校验均先于凭据读取，不调用真实服务，不等同云端转写内容验收 |
| 通用转写配置 | 设置页预填默认服务根地址与 paraformer-v2，均可编辑；保存到 `meeting.asr_base_url` / `meeting.asr_model`，worker 从 `__settings` 读取；旧设置或空值使用原默认值 | `AppNavigationSettings.test.tsx`、`meetingAsrApi.test.ts`、`bailian_asr::tests::`；3.0／3.1 ASR Flash 走同步 HTTP，其他模型需兼容百炼文件转写协议；通用／套餐配置及密钥独立 |
| 通用连接测试 | 使用界面当前未保存的地址、模型、密钥请求上传凭证；密钥空时读取已保存通用凭据 | 本地 HTTP 服务核对连接测试、上传凭证、提交与轮询的实际路径和模型；3.0／3.1 ASR Flash 测试实际识别内置短样音（少量费用），其余文件模型测试成功仅表示取得上传凭证，不等同实际录音转写成功；不消耗真实云端服务 |
| 配置页密钥查看 | 点击「显示」按需读取本通道保存的凭据，或直接展示当前输入；隐藏清除读取值，编辑后才成为待保存草稿 | `SecretInput.test.tsx`、`AppNavigationSettings.test.tsx`、`secretApi.test.ts`；读取命令与写入共用凭据名白名单，不读取其他名称；测试仅使用模拟值 |
| 套餐地址与 TLS | 根地址、订阅页 `/compatible-mode/v1`、完整实时接口及重复后缀统一到正确 WebSocket 路径；测试与转写共用 Windows 原生证书链校验及握手超时 | `bailian_plan_asr::tests::`；本地握手核对路径和鉴权头，错误区分证书／HTTP 状态；域名、有效期与系统信任检查保留，未知查询参数或含账号密码的地址拒绝且不回显 |
| 套餐 ASR Flash HTTP 识别 | 通用和套餐的 `qwen-audio-3.0-asr-flash`／`qwen-audio-3.1-asr-flash` 使用原生 HTTP `multimodal-generation/generation`，以 `input.messages[].content[].input_audio.data` 的 WAV Data URI 传入；支持 `output.text` 与扁平 `text`，缺字段报错；实时模型保留原协议；当前 Flash 接入输出不带说话人，不启用 3.1 可选的说话人分离，跨分段说话人身份未关联 | 本地 HTTP 验证设置页及转写主入口使用正确路径、模型、鉴权、采样率和音频；取消与 HTTP 错误不回退实时接口；错误不附原始响应中的密钥、录音或 Data URI |
| ASR Flash 长录音及连接测试 | 每段不超过 120 秒、WAV 不超过 6 MiB（base64 约 8 MiB），按完整声道帧切分并保留连续时间戳；设置页测试发送嵌入 EXE 的短合成语音，须识别到非空文字 | `bailian_plan_asr::tests::` 覆盖双声道高采样率样本完整性、125 秒录音经 HTTP 分段、空结果与服务拒绝；`AppNavigationSettings.test.tsx` 检查草稿测试及额度提示。测试会消耗少量套餐额度；不代表真实长会议质量验收 |
| 套餐长录音缓冲上限 | `qwen-audio-3.0-realtime-plus` 的 16 位 WAV 按 25 秒切成独立会话，每段发送后提交，低于该模型未提交缓冲区 30 秒上限；其他模型沿用 120 秒分段，结果保留原录音连续时间戳 | `bailian_plan_asr::tests::`；覆盖按模型选择时长、分段边界、超过 120 秒的录音、双声道 48 kHz 样本完整性；本地 WebSocket 检查 append 累积时长与逐段 commit；未据此宣称真实云端长会议已验收 |
| 转写失败诊断 | 合并顶层、`output` 与子文件的错误码／原因，保留任务与请求编号；子文件明确失败立即退出，缺失／未知状态不再持续轮询 | `bailian_asr::tests::`；覆盖嵌套及扁平响应、空原因、HTTP 错误、本地 HTTP 服务响应；诊断不回显整个响应中的录音地址或签名 |
| 结束后自动生成 | `meeting_watch.rs` 停录混音后由后台直接调用统一 `job_start` 启动 `meeting.generate`；不依赖前端消费一次性停录事件，前端不重复上传 | 共用原有 worker、设置注入、历史与路径授权；自动参数回归；LLM 失败仍保留转写稿；尚未进行真实 Teams 退会到云端纪要的完整验收 |
| 退会后收尾状态 | 确认退会后全局录制提示即时切换为「会议已结束，正在保存录音」，成品／失败事件结束收尾态 | `MeetingWatch.test.tsx`；音频会话兜底仍需持续停止十秒，另有封盘混音耗时；日志明确结束时不额外等待该十秒 |
| 进度、结果与失败可见 | 全局监听会议任务终态，提供桌面通知与应用内打开纪要／转写稿入口；后台快照保留录音摘要、最近任务事件及启动失败原因，晚打开页面或 WebView 重载可恢复 | `MeetingWatch.test.tsx`、`MeetingMinutesPage.test.tsx` 和 `meeting_watch::tests::`；通知不可用时仍显示应用内结果／错误；快照只在当前应用进程内保留，重启后由会议专属索引恢复已归档结果 |
| 会议历史与阅读 | 配置合并、日期分组／标题搜索、两版纪要与原始转写、复制正文；索引关联同一录音或转写稿，已落盘正文按需加载 | `storage::meeting_history::tests::`、`tests::meeting_history_restores_only_exact_files_and_bounds_transcript_reads` 与会议页测试；覆盖重启、旧数据回填、生成与阅读并行、迟到事件和授权边界；没有已登记输出路径的旧结果不能自动恢复 |

## 2026-10-26 · 会议专属历史与阅读工作区

- 去掉步骤导引，详细度、生成操作、任务进度合入会议记录配置；历史列表按日期分组并支持标题搜索，选择后在结果区切换两版纪要与原始转写。所有窗口均按「上方配置、中间历史、下方结果」纵向排列，历史列表限制高度并独立滚动。
- `Storage` 新建 `meeting_history` 索引，列表查询不返回正文；已落盘正文只保存路径，保存失败的正文保留有界内联副本（每段最多 2 MB）。首次生成／导入时间用于排序并明确标注，不推断会议实际发生时间。录音或转写稿路径关联重新生成，同条记录保留最新结果；重新生成失败时保留原可阅读内容。旧任务晚到的事件不得覆盖新任务状态，快速失败先于参数归档时不留下重复会议。
- 旧数据仅一次回填通用任务历史中已有的输出路径；根据已登记的 Markdown 读取标题，不扫描磁盘或旁边文件。旧任务没有输出路径、文件已丢失或通用历史已被清除时，无法据此完整重建旧结果，仍可手动选择已有纪要查看。会议专属索引独立于通用任务日志，清空通用任务日志不会删除会议索引或输出文件。
- `meeting_history_list` 返回元数据；`meeting_history_get` 仅按已归档 ID 恢复确切存在的文件授权，不授权父目录，也不把后来变成目录的旧文件路径加入白名单。原始转写通过 `meeting_read_transcript` 在授权检查后限读 TXT、UTF-8、2 MB；缺失、错误编码和超限分别返回中文错误。
- 前端把历史阅读和任务进度分开：后台状态继续更新，当前阅读不被替换；连续切换会议的迟到读取丢弃，查看本地纪要不清除运行任务。复制和转写预览不调用云端。浏览器非演示模式只返回空历史并拒绝本地读取；显式演示模式使用合成会议。
- 验证：`npx vitest run src/MeetingMinutesPage.test.tsx src/components/MeetingWatch.test.tsx src/api.test.ts src/components/tour/StepTourHint.test.tsx`；`npm run build`；在 `src-tauri/` 执行 `cargo --config profile.test.package.audit-toolbox.debug=0 test --lib meeting_` 与 `--lib storage::tests::`，本次子进程设置 `_LINK_=/DEBUG:NONE`。覆盖重启、归组、旧数据回填、旧事件回灌、快速失败竞态、样本文本与文件授权边界。前端构建完成后再运行 Rust，避免嵌入资源与 Vite 重建相冲突。未调用真实转写／LLM 服务，未更新安装包。

## 2026-10-26 · 微信语音输入误询问防护

- 用户反馈 Teams 在后台但没有开会时，微信语音输入触发记录询问。检查确认音频兜底仅要求采集会话，且进程归属原来接受 Teams 父 PID 下的任意后代；本次未在用户实际误触发瞬间采集会话，不能断言唯一根因。
- 进程归属只接受 `ms-teams.exe` 和其已验证链路内的 `msedgewebview2.exe`。用有限进程查询权限读取当前映像名及创建时间，子进程不得早于当前父进程创建；查询失败不猜归属。枚举活跃音频会话时再次核对映像名、PID 和创建时间，防止枚举后 PID 已复用。Teams 相关身份无法读取或在枚举中变化时返回未知，不累计成会议结束；无关应用的身份不可读取不影响 Teams 枚举。该规则也用于录音开始时选择 Teams 采集／播放设备。
- Windows 父进程编号可能因原父进程退出、PID 复用而指向无关进程，创建时间检查依据 [Microsoft 的进程编号复用说明](https://devblogs.microsoft.com/oldnewthing/20150403-00/?p=44313/)。不读取微信输入文字、音频或账户数据，不使用语音内容判断应用身份。
- 无会议日志时，仅 Teams 采集与播放会话同时连续活跃 3 秒才触发；单独麦克风或通知播放均不触发。已有会议开始后仍允许单向会话维持会态，结束沿用双向均停止十秒的规则。日志明确开始的会议不要求麦克风开启；如日志缺失且只有单向会话，则不自动询问，可用手动记录。预加入与 Teams 自身设备测试仍可能具备双向会话，不能保证判定为正式会议。
- 回归覆盖输入法及其 WebView 排除、父 PID 复用、不可读取身份、活跃会话身份变化、单向会话三十秒不开始、双向启动连续性与停止防抖；真实 Windows 进程身份读取另有本机测试。命令：在 `src-tauri/` 运行 `cargo test --lib meeting_ --config profile.test.package.audit-toolbox.debug=0`；音频只读诊断为 `cargo test --lib meeting_audio::tests::live_audio_sessions -- --ignored --nocapture`。测试不自动开会、不录音、不上传；安装 EXE 尚未替换，微信语音输入与后台 Teams 的实际误触发仍需新版实机复核。
- 本次上述 Rust 回归、导览定向 Vitest 与前端构建通过；Rust 命令仅在本次子进程设置 `_LINK_=/DEBUG:NONE`，未修改永久构建配置。新测试程序的只读音频诊断返回无 Teams 音频会话，当时进程列表中有微信输入法、没有 Teams，因此该次诊断不等同用户所述后台 Teams 场景复现。

## 2026-10-26 · ASR Flash HTTP 协议接入

- 用户在套餐模型栏填写 `qwen-audio-3.0-asr-flash` 后出现「套餐通道响应超时」。此前套餐测试与转写都强制走 WebSocket 实时接口；该模型应调用 HTTP 非实时识别接口，不能等待 `session.created`。
- 按[官方 HTTP API](https://help.aliyun.com/en/model-studio/fun-asr-flash-recorded-speech-recognition-http-api)接入原生接口，不使用文本 Chat Completions。用户提供的 `/compatible-mode/v1` 地址转换为同服务的 `/api/v1/services/aigc/multimodal-generation/generation`，HTTP 与 WebSocket 共用 Windows 原生证书链校验；HTTP 禁止重定向。
- 使用用户授权的套餐密钥与 Windows 本地合成语音在线请求，HTTP 200 且返回正确文字；静音探针返回 HTTP 400 空对象，故测试改用嵌入 EXE 的「语音测试」短样音并明确额度消耗。没有上传用户会议录音；密钥仅在一次性进程内使用，不写源码、样音、配置或测试日志。现有默认实时模型及已保存配置保持原行为。
- 本地回归：`cargo test --manifest-path src-tauri/Cargo.toml --lib bailian_plan_asr::tests::`、`npx vitest run src/AppNavigationSettings.test.tsx`、`npm run build`。可选在线 Rust 探针：设置 `AUDIT_TOOLBOX_PLAN_ASR_KEY` 后运行 `cargo test --manifest-path src-tauri/Cargo.toml --lib online_http_connection_sample -- --ignored`；上传内置合成样音且消耗少量套餐额度。安装中的旧 EXE 需重新构建才包含此修复。
- 本次验证：设置页测试与前端构建通过；Cargo 编译包装命令遭遇磁盘空间不足（Windows 112 / ENOSPC），改为直接运行本次已生成、包含新增用例的 lib 测试程序，套餐模块默认测试全部通过；同一测试程序的 `online_http_connection_sample` 单独运行通过，原生 Rust 请求识别到内置中文样音。未生成安装包、未替换现有 EXE；未清理共享 Cargo 缓存。

## 2026-10-26 · 套餐长录音缓冲超限修复

- 用户实际转写收到 `input_audio_buffer.append` 的 `Input audio buffer exceeded maximum duration (30s)` 错误。原分段为 120 秒，同一段全部发送后才提交；将 base64 拆成多条 append 消息并不会清空服务端累计缓冲。
- 按用户要求，仅 `qwen-audio-3.0-realtime-plus` 改为 25 秒分段；其他模型继续使用原有 120 秒，不推断它们也有相同限制。空模型与连接逻辑一致，按默认模型处理。每段继续使用独立 WAV、独立会话和一次 commit，保留连续样本和原录音时间戳。设置页连接成功只验证建立会话，不代表长音频转写成功。
- 回归命令：`cargo test --manifest-path src-tauri/Cargo.toml --lib bailian_plan_asr::tests::`。新增默认分段实际 WAV 时长／样本完整性检查，以及 65 秒合成录音经本地 WebSocket 逐段发送、提交和接收文字的验证；不上传用户录音，不调用真实云端转写。安装版是否包含修复，以重新构建和部署的产物为准。
- 本机套餐转写与 `--lib meeting_` 回归均通过。因默认调试构建遇到 PDB 容量上限及磁盘不足，实际测试在 `src-tauri/` 下临时使用 `cargo --config profile.test.package.audit-toolbox.debug=0 test --lib <过滤条件>`，并在该子进程环境设置 `_LINK_=/DEBUG:NONE`；未修改永久构建配置。只清理本次失败构建生成的文件，未执行全局 `cargo clean`。

## 2026-10-26 · 结果定位与询问窗生命周期

- 完成提示的版本链接进入 `/tools/meeting_minutes?version=content|timeline`，携带同一任务事件恢复正文，适用于初次打开和已保活的页面；滚动并聚焦结果标题。打开后收起完成浮层，不遮挡表格。两版／转写稿的目录操作合并为「打开输出文件夹」，仍以输出文件路径走原有授权校验，不将父目录加入授权。
- 页面状态砖与后台常驻之间增加 12px 间距；「生成纪要」替换冗长导入按钮文案，详细度和双版本生成规则保持。
- 针对 `failed to acquire webview reference`，避免同标签询问窗反复销毁重建：创建时先隐藏，只有请求仍有效才显示；后续隐藏复用，操作串行，下一场重置旧错误与忙碌状态。拒绝／叉号／Escape 同时尝试隐藏与回传，互不等待；原生退会事件负责隐藏，即使前端监听未就绪也可退场。系统关闭请求隐藏并通知不记录；关闭主窗口且后台常驻关闭时销毁隐藏小窗，保留退出语义。
- 前端回归覆盖拒绝事件未返回／失败、关闭与 Escape、旧错误清理、退会后紧接再入会、保活页面结果定位及单一目录入口。浏览器截图使用合成数据，不代表已完整复现真实 Teams 与原生 WebView 的快速切换；Windows 真机场景仍需安装包验收，当前安装 EXE 未替换。

## 2026-10-26 · 套餐连接与证书诊断

- 用户提供 `UnknownIssuer` 细节后，确认失败发生在 TLS 校验阶段。Windows 原生 TLS 对官方域名的校验通过，证书链颁发者为 GlobalSign；改为 rustls 使用 Windows 原生证书链校验，而非仅依赖内置根证书。
- 使用用户授权的套餐密钥对 `qwen-audio-3.0-realtime-plus` 实测连接成功；输入为订阅页 `/compatible-mode/v1` 地址，实际连接归一后的官方实时接口，收到会话事件即关闭。密钥通过不回显输入传入一次性测试进程环境，不写入配置、源码或测试日志。不上传音频；此结果仅验证会话建立，不代表完整会议转写或纪要内容已验收。
- 本地回归覆盖地址转换、查询编码、错误分类和模拟 WebSocket 握手。新代码尚未替换安装中的 EXE，不能以本次测试结果声称旧安装版已修复。

## 2026-10-25 · 正文展示与模板调整

- 前端第二项只保留简要／标准／详细度，移除手填标题、参会人名单。`meeting.generate` 与 `meeting.summarize` 都按内容生成一级标题；自动录音后台不再传入「Teams 会议＋时间」，旧任务中的 `title`／`participants` 参数不再用于强制标题或姓名映射。
- 任务结果新增 `minutesMarkdown`，与落盘 Markdown 完全相同；结果标题从正文首个一级标题提取。模型缺失有效标题时保留转写稿并返回 `minutesError`，不把空白纪要当成功正文。输出文件名含版本标签与时间戳，便于识别生成批次。
- 结果区直接显示标题、分节、列表与待办表格，保留文件打开及转写稿重出入口。当前进程的晚打开页面／重载沿用后台快照恢复；旧快照仅含路径时补读正文。另提供「查看已有纪要」载入已生成的 `.md` 文件，应用重启后可主动选取历史文件；不增加自动扫描所有历史会议的行为。
- 本地读取 `meeting_read_minutes` 经过 `AllowedPaths`，仅接受已选或已输出的文件／已授权目录内的 `.md`；有界读取 2 MB，UTF-8 解码，文件授权不扩展到同目录其他文件。前端 zod 校验结果，Markdown 预览不执行 HTML、不加载远程图片、不启用外链。
- 按用户后续要求，标准／详细档统一为会议信息、讨论要点、会议结论、后续事项四部分；原待办事项与待确认问题合并为后续事项表，列为类型、事项、责任人、截止时间、交付结果。类型区分「待办」和「待确认」，同一事项只列一次，不把待确认问题当作已安排的待办。简要档保留关键讨论要点、会议结论与后续事项，省略会议信息。明确要求：缺失项写「未提及」，不得猜测姓名／负责人／期限，不从转写相对时间戳推断会议日期或完整时长，不把建议写为决定，无后续事项时直接写「无」。这是提示词约束，真实模型输出质量仍需复核，不能保证所有服务商均严格遵守。
- 回归覆盖正文与表格渲染、完整任务事件、旧快照补读、本地读取失败保留其他入口、仅传详细度重出、自动标题参数、正文／文件一致、LLM 失败保留转写稿和路径授权边界。浏览器实际排版使用合成样例；开发 EXE 的 `--rust-table-worker` 已用临时合成转写稿和静音 WAV 验证部分成功／错误返回，未调用云端服务；未重新转写或上传用户 `record-20261025-223324` 录音。

## 2026-10-25 · 一次生成内容版与时间版

- `meeting.generate` 只转写一次；与 `meeting.summarize` 一样，共用所选详细度，从同一份转写稿分别调用 LLM 生成两个版本。自动结束录音、手动停止、导入音频、转写稿重出均沿用该入口。
- 内容版将同一议题的不同时段合并，同时保留建议、调整、决定的先后关系；时间版按原始顺序分连续阶段，后续重谈的议题留在后续位置。时间版只引用已有相对时间戳，无时间戳时使用阶段序号，不编造具体时刻；仍是摘要。标题分别带「（按内容）」「（按时间）」。
- 结果 `minutesVersions` 包含 `content`／`timeline` 两项，各自返回标题、正文、文件路径与错误。分别落盘 `会议纪要-按内容-{stamp}.md` 和 `会议纪要-按时间-{stamp}.md`，正文与界面一致；顶层旧字段映射到一个可用版本以兼容历史消费者。
- 单版生成失败仍继续另一版，保留成功正文、文件与转写稿；单版保存失败保留该版内联正文并继续保存另一版，不把失败路径加入 `outputPaths`。取消在版本之间检查并停止后续调用。
- 页面提供版本切换、对应文件打开和一次重新生成两版；部分失败时默认展示可用版并可切换查看原因。全局结果卡分别提供两个文件入口；晚打开页面／快照补读兼容版本数组和旧单版结构。主动选择历史 `.md` 只读取该文件，不扩大路径授权或自动读取相邻文件。
- 回归覆盖双版本不同提示词、双文件与正文一致、任一版本失败另一版保留、写盘失败、版本间取消、同一转写稿的双阶段任务进度；前端覆盖切换正文与文件、单版失败、换输入清空及全局双文件入口。浏览器以合成示例确认切换与表格排版；重编开发 EXE 后经 `--rust-table-worker` 验证双阶段进度、两版独立错误和转写稿保留，未调用云端或上传用户录音。真实云端双版本内容质量仍需人工复核；未更新安装包。

## 验证命令

```powershell
npx vitest run src/api.test.ts src/MeetingMinutesPage.test.tsx src/components/MeetingWatch.test.tsx src/lib/errors.test.ts
npx vitest run src/AppNavigationSettings.test.tsx src/meetingAsrApi.test.ts src/secretApi.test.ts src/components/SecretInput.test.tsx
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib meeting_
# 仅在已安装 WebM 和 FLAC 系统解码器时
cargo test --manifest-path src-tauri/Cargo.toml --lib meeting_minutes::media::tests::optional_windows_codecs -- --ignored
python scripts/verify_meeting_media_workers.py --exe <待验收EXE路径>
cargo test --manifest-path src-tauri/Cargo.toml --lib bailian_asr::tests::
cargo test --manifest-path src-tauri/Cargo.toml --lib bailian_plan_asr::tests::
# 只读真实设备会话枚举，不录音、不上传
cargo test --manifest-path src-tauri/Cargo.toml --lib meeting_audio::tests::live_audio_sessions -- --ignored --nocapture
```

2026-10-15 尚未拿到用户当日下午的录音，不能断言该录音实际无声；也未执行一次真实 Teams 加入、静音、退出的完整人工验收。当前安装中的 EXE 与源码修复是否一致应单独核验，不能以源码测试替代安装包验收。

2026-10-19 修复两路检测状态未同步造成的结束漏检，以及自动任务依赖前端一次性事件的问题；生成成功、转写失败与仅转写成功（LLM 失败）均有可见反馈。上述回归使用模拟状态与事件，不录制或上传用户会议；真实客户端退会、设备状态和云端服务仍需安装包验收。

2026-10-22 针对 alpha.112「自动录音后手动停止并生成纪要，只显示转写失败」反馈，修复后端漏取顶层错误和前端丢弃 `detail` 的两处诊断缺口。会议页内联进度、后台会议通知与当前进程的失败快照均保留详细原因，包含套餐通道与网络错误；不改变其他工具的错误文案。测试使用合成服务响应和页面事件，未上传用户会议，也未复现该用户的云端失败；这次具体失败原因仍待修复后的详细报错核实。应用重启后的任务历史仍仅保留摘要，不承诺恢复完整诊断。

2026-10-22 后续收到 `SUCCESS_WITH_NO_VALID_FRAGMENT` 和实际回放无声反馈：296 秒成品约 9.5 MB，日志两路初始化成功、有声时间约 0%。据此确认此例的直接失败原因是空录，尚不能凭该摘要判断麦克风静音、设备驱动、进程归属或采集中断等具体设备原因。代码原先仅在进程回环初始化失败时回退，而初始化成功不保证目标树有播放流（参见 [Microsoft 应用回环说明](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/)）。改为优先使用 Teams 实际播放端点；保留进程及默认设备兜底，记录三路音量统计，并在两条云端通道前拦截可确认的纯静音 PCM。百炼无有效语音码按 [官方错误码](https://help.aliyun.cn/zh/model-studio/error-code) 给出中文解释和回放指引，不再重复输出相同的 code/message，也不把云端 VAD 判定当作录音一定无声的证据。验证使用合成 WAV、来源选择注入及 worker 共用 `run_job` 入口；尚未在用户 Plantronics C320-M 与 Teams 环境验收，设备中途切换自动恢复尚未实现，旧空录无法从静音样本恢复谈话内容。

用户进一步确认 `track-system.wav` 与 `track-mic.wav` 单独回放都无声，因此此例的声音缺失发生在混音前。另一次「退会仍显示录制」反馈随后更正为稍后已自动结束；保留现有结束防抖，只修正明确退会到封盘混音之间的前端收尾提示，不据此修改退会判定阈值。
