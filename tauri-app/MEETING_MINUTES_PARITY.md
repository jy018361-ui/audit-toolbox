# 会议纪要原生功能验收矩阵

会议纪要是 Rust 原生功能，不依赖上一级 Python 引擎。此表记录当前行为和验证边界，不表示全部 Teams 版本与设备组合均经真机验收。

| 行为 | Rust / 前端实现 | 回归与边界 |
| --- | --- | --- |
| Teams 日志开始/结束 | `meeting_watch.rs` 跟踪全部 SlimCore 日志，按标记时间合并；首轮推断当前状态 | `meeting_watch::tests::`；不保证 Teams 始终写这些非公开日志 |
| 日志缺失时兜底 | `meeting_audio.rs` 枚举 Teams 进程树的 Windows 活跃音频会话；采集持续 3 秒才开始；双向流都停止 10 秒才结束；日志与音频每轮同步当前会态，可交叉接管结束检测 | 进程树和防抖回归；含日志开始后麦克风始终关闭、音频开始后仅日志结束、下一场防抖重置；静音看流状态，不看音量；枚举失败不作为结束信号 |
| 录音前询问 | `MeetingWatch.tsx` 订阅后读取快照，结束关闭独立小窗与降级弹窗 | `MeetingWatch.test.tsx`；预加入麦克风预览或 Teams 设备测试可能触发启发式询问；不会自动同意录音 |
| 会议系统声 | `meeting_record.rs` 优先按 Teams 活跃播放会话选实际播放设备回环，设备不可用才回退 Teams 进程树，最后默认通信／播放设备；备用来源明确提醒 | 来源优先级及失败回退回归；设备回环会包含同一设备上其他应用的声音，开录提醒；多账户、多个独立 Teams 根进程及录音中途切换设备尚未全部验收 |
| 麦克风 | 优先选 Teams 活跃采集会话设备；其次音量峰值；最终默认通信麦克风并告警 | 与 Windows 会话共用归属逻辑；设备临时切换后自动重连尚未实现 |
| 录音质量提示 | 初始来源和警告写 `recording-start.json`，最终成品、警告和系统声／麦克风／混音的 `audioStats` 写 `recording-summary.json`；页面提醒不会被转写启动清掉 | `MeetingMinutesPage.test.tsx`、`meeting_record::tests::`；统计含样本数、非零样本数、归一化峰值和 RMS；不把初始化成功等同采集有声，RMS 体检仍只是启发式 |
| 纯静音上传拦截 | `meeting.generate` 在读取密钥和调用云端之前检查可解析的 16 位 PCM WAV，全零／空数据直接中文报错，保留原文件；通用和套餐通道共用 | `meeting_minutes::tests::`、`meeting_record::tests::`；低音量、包含非零数据或本地不支持解析的导入格式不据此拦截，交由原有云端解码；不宣称可判断是否有人声 |
| 百炼文件转写 | HTTP 信封读取 `output.results`（兼容扁平快照）；提取结果地址后下载文本 | `bailian_asr::tests::`；真实结构成功、子文件失败、空结果与缺字段分别回归；不再把缺字段误报为无人声 |
| 转写失败诊断 | 合并顶层、`output` 与子文件的错误码／原因，保留任务与请求编号；子文件明确失败立即退出，缺失／未知状态不再持续轮询 | `bailian_asr::tests::`；覆盖嵌套及扁平响应、空原因、HTTP 错误、本地 HTTP 服务响应；诊断不回显整个响应中的录音地址或签名 |
| 结束后自动生成 | `meeting_watch.rs` 停录混音后由后台直接调用统一 `job_start` 启动 `meeting.generate`；不依赖前端消费一次性停录事件，前端不重复上传 | 共用原有 worker、设置注入、历史与路径授权；自动参数回归；LLM 失败仍保留转写稿；尚未进行真实 Teams 退会到云端纪要的完整验收 |
| 退会后收尾状态 | 确认退会后全局录制提示即时切换为「会议已结束，正在保存录音」，成品／失败事件结束收尾态 | `MeetingWatch.test.tsx`；音频会话兜底仍需持续停止十秒，另有封盘混音耗时；日志明确结束时不额外等待该十秒 |
| 进度、结果与失败可见 | 全局监听会议任务终态，提供桌面通知与应用内打开纪要／转写稿入口；后台快照保留录音摘要、最近任务事件及启动失败原因，晚打开页面或 WebView 重载可恢复 | `MeetingWatch.test.tsx`、`MeetingMinutesPage.test.tsx` 和 `meeting_watch::tests::`；通知不可用时仍显示应用内结果／错误；快照只在当前应用进程内保留，应用重启后仍通过任务历史查找文件 |

## 验证命令

```powershell
npx vitest run src/MeetingMinutesPage.test.tsx src/components/MeetingWatch.test.tsx src/lib/errors.test.ts
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib meeting_
cargo test --manifest-path src-tauri/Cargo.toml --lib bailian_asr::tests::
# 只读真实设备会话枚举，不录音、不上传
cargo test --manifest-path src-tauri/Cargo.toml --lib meeting_audio::tests::live_audio_sessions -- --ignored --nocapture
```

2026-10-15 尚未拿到用户当日下午的录音，不能断言该录音实际无声；也未执行一次真实 Teams 加入、静音、退出的完整人工验收。当前安装中的 EXE 与源码修复是否一致应单独核验，不能以源码测试替代安装包验收。

2026-10-19 修复两路检测状态未同步造成的结束漏检，以及自动任务依赖前端一次性事件的问题；生成成功、转写失败与仅转写成功（LLM 失败）均有可见反馈。上述回归使用模拟状态与事件，不录制或上传用户会议；真实客户端退会、设备状态和云端服务仍需安装包验收。

2026-10-22 针对 alpha.112「自动录音后手动停止并生成纪要，只显示转写失败」反馈，修复后端漏取顶层错误和前端丢弃 `detail` 的两处诊断缺口。会议页内联进度、后台会议通知与当前进程的失败快照均保留详细原因，包含套餐通道与网络错误；不改变其他工具的错误文案。测试使用合成服务响应和页面事件，未上传用户会议，也未复现该用户的云端失败；这次具体失败原因仍待修复后的详细报错核实。应用重启后的任务历史仍仅保留摘要，不承诺恢复完整诊断。

2026-10-22 后续收到 `SUCCESS_WITH_NO_VALID_FRAGMENT` 和实际回放无声反馈：296 秒成品约 9.5 MB，日志两路初始化成功、有声时间约 0%。据此确认此例的直接失败原因是空录，尚不能凭该摘要判断麦克风静音、设备驱动、进程归属或采集中断等具体设备原因。代码原先仅在进程回环初始化失败时回退，而初始化成功不保证目标树有播放流（参见 [Microsoft 应用回环说明](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/)）。改为优先使用 Teams 实际播放端点；保留进程及默认设备兜底，记录三路音量统计，并在两条云端通道前拦截可确认的纯静音 PCM。百炼无有效语音码按 [官方错误码](https://help.aliyun.cn/zh/model-studio/error-code) 给出中文解释和回放指引，不再重复输出相同的 code/message，也不把云端 VAD 判定当作录音一定无声的证据。验证使用合成 WAV、来源选择注入及 worker 共用 `run_job` 入口；尚未在用户 Plantronics C320-M 与 Teams 环境验收，设备中途切换自动恢复尚未实现，旧空录无法从静音样本恢复谈话内容。

用户进一步确认 `track-system.wav` 与 `track-mic.wav` 单独回放都无声，因此此例的声音缺失发生在混音前。另一次「退会仍显示录制」反馈随后更正为稍后已自动结束；保留现有结束防抖，只修正明确退会到封盘混音之间的前端收尾提示，不据此修改退会判定阈值。
