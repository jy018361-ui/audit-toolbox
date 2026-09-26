import { z } from "zod";

export const ToolManifestSchema = z.object({
  id: z.string(), name: z.string(), description: z.string(), route: z.string(),
  version: z.string(), capabilities: z.array(z.string()), migrationStatus: z.enum(["ready", "preview", "legacy", "upcoming"])
});
export type ToolManifest = z.infer<typeof ToolManifestSchema>;

export const BootstrapSchema = z.object({
  appVersion: z.string(), platform: z.string(), arch: z.string(), webview2: z.boolean(),
  engine: z.object({ available: z.boolean(), version: z.string().nullable(), mode: z.string() }),
  dataDir: z.string(), migrationRequired: z.boolean()
});
export type Bootstrap = z.infer<typeof BootstrapSchema>;

export const JobEventSchema = z.object({
  jobId: z.string(), toolId: z.string(), phase: z.string(), current: z.number(), total: z.number(),
  message: z.string(), severity: z.enum(["info", "warning", "error", "success"]),
  outputPaths: z.array(z.string()).default([]), result: z.unknown().optional()
});
export type JobEvent = z.infer<typeof JobEventSchema>;

export const AppErrorSchema = z.object({
  code: z.string(), userMessage: z.string(), retryable: z.boolean(), diagnosticId: z.string(), detail: z.string().optional()
});
export type AppError = z.infer<typeof AppErrorSchema>;

export type TaskRecord = JobEvent & { startedAt: string; finishedAt?: string };

/** 历史记录行：params 是任务启动时的用户原始参数，供「继续任务」回填；
 * method 区分主任务与读取/筛选等子步骤。 */
export const HistoryRowSchema = z.object({
  jobId: z.string(),
  toolId: z.string(),
  status: z.string(),
  message: z.string().nullable(),
  outputPaths: z.array(z.string()).default([]),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  params: z.record(z.string(), z.unknown()).default({}),
  method: z.string().default(""),
});
export type HistoryRow = z.infer<typeof HistoryRowSchema>;

/** 「继续任务」取回的参数存档：missingPaths 是已不存在于本机的原输入。 */
export const TaskRestoreSchema = z.object({
  jobId: z.string(),
  toolId: z.string(),
  params: z.record(z.string(), z.unknown()).default({}),
  snapshot: z.unknown().nullable().optional(),
  snapshotStatus: z
    .enum(["valid", "none", "missing", "stale", "incompatible"])
    .optional(),
  missingPaths: z.array(z.string()).default([]),
  authorizedPathCount: z.number().default(0),
  method: z.string().default(""),
});
export type TaskRestore = z.infer<typeof TaskRestoreSchema>;

/** 会议纪要助手：Rust 侧 meeting-event 事件载荷（Teams 通话开始/结束）。 */
export const MeetingEventSchema = z.object({
  type: z.enum(["call_started", "call_ended"]),
  at: z.string(),
});
export type MeetingEvent = z.infer<typeof MeetingEventSchema>;

/** 会议检测与录音的当前状态（meeting_status 命令返回）。 */
export const MeetingStatusSchema = z.object({
  watchEnabled: z.boolean(),
  resident: z.boolean(),
  inCall: z.boolean(),
  logFound: z.boolean(),
  recording: z.boolean(),
});
export type MeetingStatus = z.infer<typeof MeetingStatusSchema>;

export const MeetingRecordStartSchema = z.object({
  startedAt: z.string(),
  recordDir: z.string(),
  systemOk: z.boolean(),
  micOk: z.boolean(),
  warnings: z.array(z.string()).default([]),
});
export type MeetingRecordStart = z.infer<typeof MeetingRecordStartSchema>;

export const MeetingRecordStopSchema = z.object({
  audioPath: z.string(),
  recordDir: z.string(),
  durationSec: z.number(),
  sizeBytes: z.number(),
  startedAt: z.string(),
  warnings: z.array(z.string()).default([]),
});
export type MeetingRecordStop = z.infer<typeof MeetingRecordStopSchema>;
