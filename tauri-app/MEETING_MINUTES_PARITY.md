# 会议纪要原生功能验收矩阵

会议纪要是 Rust 原生功能，不依赖上一级 Python 引擎。此表记录当前行为和验证边界，不表示全部 Teams 版本与设备组合均经真机验收。

| 行为 | Rust / 前端实现 | 回归与边界 |
| --- | --- | --- |
| Teams 日志开始/结束 | `meeting_watch.rs` 跟踪全部 SlimCore 日志，按标记时间合并；首轮推断当前状态 | `meeting_watch::tests::`；不保证 Teams 始终写这些非公开日志 |
| 日志缺失时兜底 | `meeting_audio.rs` 枚举 Teams 进程树的 Windows 活跃音频会话；采集持续 3 秒才开始；双向流都停止 10 秒才结束；日志与音频每轮同步当前会态，可交叉接管结束检测 | 进程树和防抖回归；含日志开始后麦克风始终关闭、音频开始后仅日志结束、下一场防抖重置；静音看流状态，不看音量；枚举失败不作为结束信号 |
| 录音前询问 | `MeetingWatch.tsx` 订阅后读取快照，结束关闭独立小窗与降级弹窗 | `MeetingWatch.test.tsx`；预加入麦克风预览或 Teams 设备测试可能触发启发式询问；不会自动同意录音 |
| 会议系统声 | `meeting_record.rs` Teams 主进程树回环，失败才回退默认播放设备 | 主进程选取回归；多账户、多独立 Teams 根进程的音频归属尚未全部验收 |
| 麦克风 | 优先选 Teams 活跃采集会话设备；其次音量峰值；最终默认通信麦克风并告警 | 与 Windows 会话共用归属逻辑；设备临时切换后自动重连尚未实现 |
| 录音质量提示 | 初始来源和警告写 `recording-start.json`，最终成品与警告写 `recording-summary.json`；页面提醒不会被转写启动清掉 | `MeetingMinutesPage.test.tsx`；落盘失败不阻断音频保存；无声体检只是启发式，不等同语音识别 |
| 百炼文件转写 | HTTP 信封读取 `output.results`（兼容扁平快照）；提取结果地址后下载文本 | `bailian_asr::tests::`；真实结构成功、子文件失败、空结果与缺字段分别回归；不再把缺字段误报为无人声 |
| 转写失败诊断 | 合并顶层、`output` 与子文件的错误码／原因，保留任务与请求编号；子文件明确失败立即退出，缺失／未知状态不再持续轮询 | `bailian_asr::tests::`；覆盖嵌套及扁平响应、空原因、HTTP 错误、本地 HTTP 服务响应；诊断不回显整个响应中的录音地址或签名 |
| 结束后自动生成 | `meeting_watch.rs` 停录混音后由后台直接调用统一 `job_start` 启动 `meeting.generate`；不依赖前端消费一次性停录事件，前端不重复上传 | 共用原有 worker、设置注入、历史与路径授权；自动参数回归；LLM 失败仍保留转写稿；尚未进行真实 Teams 退会到云端纪要的完整验收 |
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
