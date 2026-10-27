# 会议纪要原生功能验收矩阵

会议纪要是 Rust 原生功能，不依赖上一级 Python 引擎。此表记录当前行为和验证边界，不表示全部 Teams 版本与设备组合均经真机验收。

| 行为 | Rust / 前端实现 | 回归与边界 |
| --- | --- | --- |
| Teams 日志开始/结束 | `meeting_watch.rs` 跟踪全部 SlimCore 日志，按标记时间合并；首轮推断当前状态 | `meeting_watch::tests::`；不保证 Teams 始终写这些非公开日志 |
| 日志缺失时兜底 | `meeting_audio.rs` 按映像名、进程创建时间与 Teams 父子关系校验音频归属；Teams 采集和播放会话同时持续活跃 3 秒才开始；双向流都停止 10 秒才结束；日志与音频每轮同步当前会态，可交叉接管结束检测 | 覆盖无关输入法／WebView、父 PID 复用、枚举后 PID 变化、身份不可读取、单向会话和防抖重置；含日志开始后麦克风始终关闭、音频开始后仅日志结束；静音看流状态，不看音量；枚举失败不作为结束信号 |
| 录音前询问 | `MeetingWatch.tsx` 订阅后读取快照，独立小窗隐藏复用；退会在 Rust 与前端隐藏，并关闭降级弹窗 | `MeetingWatch.test.tsx`、`MeetingAskWindow.test.tsx`；覆盖串行显示／隐藏、拒绝和关闭不等待回传、旧请求不污染下一场；预加入麦克风预览或 Teams 设备测试可能触发启发式询问；不会自动同意录音 |
| 会议系统声 | `meeting_record.rs` 优先按 Teams 活跃播放会话选实际播放设备回环，设备不可用才回退 Teams 进程树，最后默认通信／播放设备；备用来源明确提醒 | 来源优先级及失败回退回归；设备回环会包含同一设备上其他应用的声音，开录提醒；多账户、多个独立 Teams 根进程及录音中途切换设备尚未全部验收 |
| 麦克风 | 优先选 Teams 活跃采集会话设备；其次音量峰值；最终默认通信麦克风并告警 | 与 Windows 会话共用归属逻辑；设备临时切换后自动重连尚未实现 |
| 录音质量提示 | 初始来源和警告写 `recording-start.json`，最终成品、警告和系统声／麦克风／混音的 `audioStats` 写 `recording-summary.json`；页面提醒不会被转写启动清掉 | `MeetingMinutesPage.test.tsx`、`meeting_record::tests::`；统计含样本数、非零样本数、归一化峰值和 RMS；不把初始化成功等同采集有声，RMS 体检仍只是启发式 |
| 纯静音上传拦截 | `meeting.generate` 在读取密钥和调用云端之前检查可解析的 16 位 PCM WAV，全零／空数据直接中文报错，保留原文件；通用和套餐通道共用 | `meeting_minutes::tests::`、`meeting_record::tests::`；低音量、包含非零数据或本地不支持解析的导入格式不据此拦截，交由原有云端解码；不宣称可判断是否有人声 |
| 百炼文件转写 | HTTP 信封读取 `output.results`（兼容扁平快照）；提取结果地址后下载文本 | `bailian_asr::tests::`；真实结构成功、子文件失败、空结果与缺字段分别回归；不再把缺字段误报为无人声 |
| 通用转写配置 | 设置页预填默认服务根地址与 paraformer-v2，均可编辑；保存到 `meeting.asr_base_url` / `meeting.asr_model`，worker 从 `__settings` 读取；旧设置或空值使用原默认值 | `AppNavigationSettings.test.tsx`、`meetingAsrApi.test.ts`、`bailian_asr::tests::`；自定义模型需兼容百炼文件转写协议；通用／套餐配置及密钥独立 |
| 通用连接测试 | 使用界面当前未保存的地址、模型、密钥请求上传凭证；密钥空时读取已保存通用凭据 | 本地 HTTP 服务核对连接测试、上传凭证、提交与轮询的实际路径和模型；测试成功仅表示取得上传凭证，不等同实际录音转写成功；不消耗真实云端服务 |
| 配置页密钥查看 | 点击「显示」按需读取本通道保存的凭据，或直接展示当前输入；隐藏清除读取值，编辑后才成为待保存草稿 | `SecretInput.test.tsx`、`AppNavigationSettings.test.tsx`、`secretApi.test.ts`；读取命令与写入共用凭据名白名单，不读取其他名称；测试仅使用模拟值 |
| 套餐地址与 TLS | 根地址、订阅页 `/compatible-mode/v1`、完整实时接口及重复后缀统一到正确 WebSocket 路径；测试与转写共用 Windows 原生证书链校验及握手超时 | `bailian_plan_asr::tests::`；本地握手核对路径和鉴权头，错误区分证书／HTTP 状态；域名、有效期与系统信任检查保留，未知查询参数或含账号密码的地址拒绝且不回显 |
| 套餐 ASR Flash HTTP 识别 | `qwen-audio-3.0-asr-flash` 使用原生 HTTP `multimodal-generation/generation`，以 `input.messages[].content[].input_audio.data` 的 WAV Data URI 传入；支持 `output.text` 与扁平 `text`，缺字段报错；实时模型保留原协议 | 本地 HTTP 验证设置页及转写主入口使用正确路径、模型、鉴权、采样率和音频；取消与 HTTP 错误不回退实时接口；错误不附原始响应中的密钥、录音或 Data URI |
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
