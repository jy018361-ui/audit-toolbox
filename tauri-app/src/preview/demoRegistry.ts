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
  localStorage.getItem(DEMO_FLAG_KEY) === "1";

export const demoLookup = (method: string): DemoHandler | undefined =>
  demoDataEnabled() ? registry.get(method) : undefined;

export const demoJobLookup = (method: string): DemoJobHandler | undefined =>
  demoDataEnabled() ? jobRegistry.get(method) : undefined;

/** 演示模式下"选中"的假文件路径，让文件槽位与后续链路可走通。 */
export const demoPath = (name: string) => `C:\\演示数据\\${name}`;

// —— 演示任务事件总线：api.ts 的 jobStart/listenJobEvents 在预览模式下接到这里 ——

const jobListeners = new Set<(event: JobEvent) => void>();
const cancelledDemoJobs = new Set<string>();

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
  cancelledDemoJobs.add(jobId);
  return true;
}

export function isDemoJobCancelled(jobId: string): boolean {
  return cancelledDemoJobs.has(jobId);
}
