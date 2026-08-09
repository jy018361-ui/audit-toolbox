import { z } from "zod";

export const ToolManifestSchema = z.object({
  id: z.string(), name: z.string(), description: z.string(), route: z.string(),
  version: z.string(), capabilities: z.array(z.string()), migrationStatus: z.enum(["ready", "preview", "legacy"])
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
