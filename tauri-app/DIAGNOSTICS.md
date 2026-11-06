# 本地诊断日志

在「设置 → 诊断日志 → 查看日志」可直接查看最近 200 条本机记录，按时间倒序排列。点条目展开详情，点「刷新」读取最新记录。关闭记录开关后，已有日志仍可查看。需要分享或查看较早的留存记录时可导出 ZIP。

设置 → 诊断日志。默认开启，可即时关闭、导出 ZIP、清空旧日志。日志不上传；需用户手动发送诊断包。正式和 Dev 通道沿用各自数据目录，在其 `diagnostics/` 子目录保存，开关标记在进程间共享，正在运行的 worker 也会停止记录新事件。

诊断覆盖成功与失败：页面导航、按钮点击位置、控件变化位置（下拉选项序号/复选状态）、拖动起点和位移、滚轮与修饰键、窗口尺寸和像素比、前端命令调用与耗时、设置变更摘要、engine/job 的参数结构、同步结果结构、任务进度与终态结果结构、worker 启动及退出码、AppError 错误编号/诊断编号/创建位置、前端代码位置和 Rust panic 代码栈。业务语义错误不要求先抛异常。相同任务阶段的普通进度最多每秒一条，阶段切换、终态和警告不受此限制；滚轮每半秒采样一条，窗口尺寸变化合并记录。

每条 JSONL 有 UTC 时间、应用版本、session、pid；callId 关联调用开始/结束；jobId 关联 worker 和任务进度；diagnosticId 关联用户错误及创建位置。跨进程关联用 worker_spawn.workerPid 与 worker_request.jobId。导出包含环境 manifest（版本、通道、架构、Windows build、WebView2 可用性及导出时内存）、说明及日志文件，不包含 SQLite、凭据库或原始输入输出文件。

隐私边界：自由文本、路径、动态字段名、业务数值只保留加盐指纹与结构，指纹密钥不随包导出；凭据相关字段、`value` 及 `__` 注入字段整体移除。少数固定配置键（如 headerRow）及计数保留数值。摘要限制层级、数组采样及节点预算。不会记录控件输入原文、完整报错原文、账表原文、合同/纪要原文或录音。日志可以对照输入是否变化、映射是否变化，但不能还原被脱敏的文字和金额；分析数据语义仍可能需要截图或脱敏样例。系统强杀、断电等不保证留下崩溃栈。

每文件上限 2 MiB，最多保留 12 份，最长 7 天（写入/查看/导出时清理）；多进程并发时清理为尽力执行，总量为约 24 MiB。关闭保留旧记录；清空只删除日志，保留开关与指纹密钥。记录失败不影响业务命令；设置页显示最近写入错误，支持重试读取。日志目录初始化失败也不阻止业务启动。

排查时按 `at` 合并 JSONL，查找相关 method/jobId，再顺序检查参数结构、控件变更、返回结构、任务阶段和错误位置。请用户同时提供问题现象、预期结果、大致时间和涉及工具；优先对照同一输入的前后指纹。诊断包不具备自动回放功能。

验证：`npx vitest run src/diagnostics.test.ts src/components/DiagnosticsSettings.test.tsx src/AppNavigationSettings.test.tsx`、`npm run build`、`cargo test --manifest-path src-tauri/Cargo.toml --lib diagnostics::`、`cargo test --manifest-path src-tauri/Cargo.toml --lib excel_merger::`。
