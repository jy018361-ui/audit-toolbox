// 演示数据注册表：浏览器预览模式下，用仓库内固定的样例数据代替 Rust 引擎返回，
// 让"上传文件之后才会出现"的数据化布局可以被随时检查。
// 仅预览模式生效（见 api.ts 的 engineCall/pickPath/jobStart 拦截）；桌面应用完全不受影响。
// 每个 src/preview/demo/*.ts 可导出：
//   handlers: Record<方法名, (params) => 返回值>              —— 同步 engineCall 回放
//   jobHandlers: Record<任务方法名, (params) => 任务事件序列>  —— jobStart 事件流回放
// 这里通过 import.meta.glob 自动收拢，新增工具演示数据不需要改本文件。

import type { JobEvent } from "../types";

export type DemoHandler = (params: Record<string, unknown>) => unknown;
/** 任务事件序列：jobId/toolId 由 api 层统一填充，演示文件只描述过程与结果。 */
export type DemoJobEvent = Omit<JobEvent, "jobId" | "toolId">;
export type DemoJobHandler = (params: Record<string, unknown>) => DemoJobEvent[];

const modules = import.meta.glob("./demo/*.ts", {
  eager: true,
}) as Record<string, { handlers?: Record<string, DemoHandler>; jobHandlers?: Record<string, DemoJobHandler> }>;

const registry = new Map<string, DemoHandler>();
const jobRegistry = new Map<string, DemoJobHandler>();
for (const mod of Object.values(modules)) {
  for (const [method, handler] of Object.entries(mod.handlers ?? {})) {
    registry.set(method, handler);
  }
  for (const [method, planner] of Object.entries(mod.jobHandlers ?? {})) {
    jobRegistry.set(method, planner);
  }
}

export const DEMO_FLAG_KEY = "audit-toolbox.demo-data";

/** 演示数据开关：预览模式下 localStorage 置为 "1" 后生效，刷新页面生效更完整。 */
export const demoDataEnabled = (): boolean =>
  typeof localStorage !== "undefined" &&
  (localStorage.getItem(DEMO_FLAG_KEY) === "1" ||
    (typeof location !== "undefined" && new URLSearchParams(location.search).get("demo") === "1"));

export const demoLookup = (method: string): DemoHandler | undefined =>
  demoDataEnabled() ? registry.get(method) : undefined;

export const demoJobLookup = (method: string): DemoJobHandler | undefined =>
  demoDataEnabled() ? jobRegistry.get(method) : undefined;

/** 演示模式下"选中"的假文件路径，让文件槽位与后续链路可走通。 */
export const demoPath = (name: string) => `C:\\演示数据\\${name}`;

// —— 演示任务事件总线：api.ts 的 jobStart/listenJobEvents 在预览模式下接到这里 ——

const jobListeners = new Set<(event: JobEvent) => void>();
const cancelledDemoJobs = new Set<string>();

export type DemoReplayPhase = "queued" | "running" | "paused" | "memory_paused" | "completed" | "failed" | "cancelled";
type DemoReplayJob = {
  jobId: string;
  method: string;
  toolId: string;
  events: DemoJobEvent[];
  cursor: number;
  timers: Array<ReturnType<typeof setTimeout>>;
  lastEvent?: JobEvent;
};
const replayJobs = new Map<string, DemoReplayJob>();
let autoPlayback = true;

function clearReplayTimers(job: DemoReplayJob): void {
  for (const timer of job.timers) clearTimeout(timer);
  job.timers = [];
}

function publishReplayEvent(job: DemoReplayJob, event: DemoJobEvent): JobEvent {
  const complete = { ...event, jobId: job.jobId, toolId: job.toolId };
  job.lastEvent = complete;
  emitDemoJobEvent(complete);
  return complete;
}

function scheduleReplay(job: DemoReplayJob): void {
  clearReplayTimers(job);
  job.events.slice(job.cursor).forEach((event, offset) => {
    job.timers.push(setTimeout(() => {
      if (isDemoJobCancelled(job.jobId)) return;
      job.cursor += 1;
      publishReplayEvent(job, event);
    }, 260 * (offset + 1)));
  });
}

/** Register a preview job so browser audits can hold or inject its actual event stream. */
export function registerDemoReplayJob(jobId: string, method: string, toolId: string, events: DemoJobEvent[]): void {
  const job: DemoReplayJob = { jobId, method, toolId, events, cursor: 0, timers: [] };
  replayJobs.set(jobId, job);
  if (autoPlayback) scheduleReplay(job);
}

/** Disabled playback applies to both existing and subsequently started preview jobs. */
export function setDemoAutoPlayback(enabled: boolean): void {
  autoPlayback = enabled;
  for (const job of replayJobs.values()) {
    if (enabled) scheduleReplay(job);
    else clearReplayTimers(job);
  }
}

export function demoReplayJobs(): Array<{
  jobId: string; method: string; toolId: string; lastEvent?: JobEvent; plannedPhases: string[];
}> {
  return [...replayJobs.values()].map(({ jobId, method, toolId, lastEvent, events }) => ({
    jobId, method, toolId, lastEvent, plannedPhases: events.map((event) => event.phase),
  }));
}

/** Inject through the same event bus as Rust job events; never mutate real files or jobs. */
export function injectDemoJobEvent(
  jobId: string,
  phase: DemoReplayPhase,
  overrides: Partial<DemoJobEvent> = {},
): JobEvent | undefined {
  const job = replayJobs.get(jobId);
  if (!job || isDemoJobCancelled(jobId)) return undefined;
  clearReplayTimers(job);
  const plannedIndex = job.events.findIndex((event, index) => index >= job.cursor && event.phase === phase);
  const planned = plannedIndex >= 0 ? job.events[plannedIndex] : undefined;
  const latest = job.lastEvent ?? job.events[Math.max(0, job.cursor - 1)];
  const event: DemoJobEvent = {
    current: planned?.current ?? latest?.current ?? 0,
    total: planned?.total ?? latest?.total ?? 100,
    message: planned?.message ?? (
      phase === "failed" ? "演示任务处理失败，请检查输入后重试。"
        : phase === "cancelled" ? "演示任务已取消。"
          : phase === "paused" ? "演示任务已暂停。" : "演示任务处理中…"
    ),
    severity: planned?.severity ?? (phase === "failed" ? "error" : phase === "cancelled" ? "warning" : "info"),
    outputPaths: planned?.outputPaths ?? [],
    ...(planned?.result === undefined ? {} : { result: planned.result }),
    ...overrides,
    phase,
  };
  if (["completed", "failed", "cancelled"].includes(phase)) job.cursor = job.events.length;
  else if (plannedIndex >= 0) job.cursor = plannedIndex + 1;
  return publishReplayEvent(job, event);
}

export function resumeDemoReplayJob(jobId: string): boolean {
  const job = replayJobs.get(jobId);
  if (!job || isDemoJobCancelled(jobId) || job.cursor >= job.events.length) return false;
  scheduleReplay(job);
  return true;
}

export function subscribeDemoJobs(listener: (event: JobEvent) => void): () => void {
  jobListeners.add(listener);
  return () => {
    jobListeners.delete(listener);
  };
}

export function emitDemoJobEvent(event: JobEvent): void {
  for (const listener of jobListeners) listener(event);
}

export function cancelDemoJob(jobId: string): boolean {
  if (!jobId.startsWith("demo-job-")) return false;
  if (cancelledDemoJobs.has(jobId)) return true;
  injectDemoJobEvent(jobId, "cancelled");
  cancelledDemoJobs.add(jobId);
  return true;
}

export function isDemoJobCancelled(jobId: string): boolean {
  return cancelledDemoJobs.has(jobId);
}
