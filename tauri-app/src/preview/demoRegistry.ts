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
  /** 最近一次 running 事件的进度：终态缺省事件从中断处续算，而不是落在完成的 100%。 */
  lastRunningEvent?: JobEvent;
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
  if (event.phase === "running") job.lastRunningEvent = complete;
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

function demoFailureMessage(method: string): string {
  if (method === "file_list.scan") return "演示失败：模拟目录读取中断。请重新选择文件夹并扫描。";
  if (method === "file_list.export") return "演示失败：模拟清单写入失败。请检查输出位置后重试。";
  if (method === "pdf2excel.convert") return "演示失败：模拟 PDF 转换中断。请检查回函文件后重试。";
  if (method.startsWith("excel_merger.")) return "演示失败：模拟表格合并中断。请检查输入文件后重试。";
  if (method.startsWith("tbje_check.")) return "演示失败：模拟账表核对中断。请检查 TB、JE 映射后重试。";
  if (method.startsWith("fx.")) return "演示失败：模拟汇兑测算中断。请检查来源与币种映射后重试。";
  if (method.startsWith("deposit.")) return "演示失败：模拟存款测算中断。请检查余额表与利率设置后重试。";
  if (method.startsWith("loan.")) return "演示失败：模拟借款测算中断。请检查借款表与利率设置后重试。";
  return "演示失败：模拟处理过程中断。请检查本工具的输入资料后重试。";
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
  // P3-2：补发 failed/cancelled 缺省事件时，进度沿用最近一次 running 的中断点，
  // 不再继承 completed 事件的 current=total，避免“处理失败 100%”“已取消 100%”。
  const progressBase = phase === "failed" || phase === "cancelled"
    ? job.lastRunningEvent ?? latest
    : latest;
  const event: DemoJobEvent = {
    current: planned?.current ?? progressBase?.current ?? 0,
    total: planned?.total ?? progressBase?.total ?? 100,
    message: planned?.message ?? (
      phase === "failed" ? demoFailureMessage(job.method)
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
