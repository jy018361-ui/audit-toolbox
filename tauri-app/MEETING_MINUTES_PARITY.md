# 会议纪要原生功能验收矩阵

会议纪要是 Rust 原生功能，不依赖上一级 Python 引擎。此表记录当前行为和验证边界，不表示全部 Teams 版本与设备组合均经真机验收。

| 行为 | Rust / 前端实现 | 回归与边界 |
| --- | --- | --- |
| Teams 日志开始/结束 | `meeting_watch.rs` 跟踪全部 SlimCore 日志，按标记时间合并；首轮推断当前状态 | `meeting_watch::tests::`；不保证 Teams 始终写这些非公开日志 |
| 日志缺失时兜底 | `meeting_audio.rs` 枚举 Teams 进程树的 Windows 活跃音频会话；采集持续 3 秒才开始；双向流都停止 10 秒才结束 | 进程树和防抖回归；静音看流状态，不看音量；枚举失败不作为结束信号 |
| 录音前询问 | `MeetingWatch.tsx` 订阅后读取快照，结束关闭独立小窗与降级弹窗 | `MeetingWatch.test.tsx`；预加入麦克风预览或 Teams 设备测试可能触发启发式询问；不会自动同意录音 |
| 会议系统声 | `meeting_record.rs` Teams 主进程树回环，失败才回退默认播放设备 | 主进程选取回归；多账户、多独立 Teams 根进程的音频归属尚未全部验收 |
| 麦克风 | 优先选 Teams 活跃采集会话设备；其次音量峰值；最终默认通信麦克风并告警 | 与 Windows 会话共用归属逻辑；设备临时切换后自动重连尚未实现 |
| 录音质量提示 | 初始来源和警告写 `recording-start.json`，最终成品与警告写 `recording-summary.json`；页面提醒不会被转写启动清掉 | `MeetingMinutesPage.test.tsx`；落盘失败不阻断音频保存；无声体检只是启发式，不等同语音识别 |
| 百炼文件转写 | HTTP 信封读取 `output.results`（兼容扁平快照）；提取结果地址后下载文本 | `bailian_asr::tests::`；真实结构成功、子文件失败、空结果与缺字段分别回归；不再把缺字段误报为无人声 |
| 纪要生成 | 继续使用原有 `meeting.generate` / `meeting.summarize` worker、取消机制与 LLM 设置注入 | `meeting_minutes::tests::`；LLM 失败仍保留转写稿 |

## 验证命令

```powershell
npx vitest run src/MeetingMinutesPage.test.tsx src/components/MeetingWatch.test.tsx
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib meeting_
cargo test --manifest-path src-tauri/Cargo.toml --lib bailian_asr::tests::
# 只读真实设备会话枚举，不录音、不上传
cargo test --manifest-path src-tauri/Cargo.toml --lib meeting_audio::tests::live_audio_sessions -- --ignored --nocapture
```

2026-10-15 尚未拿到用户当日下午的录音，不能断言该录音实际无声；也未执行一次真实 Teams 加入、静音、退出的完整人工验收。当前安装中的 EXE 与源码修复是否一致应单独核验，不能以源码测试替代安装包验收。
