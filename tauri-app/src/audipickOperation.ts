import { useSyncExternalStore } from "react";
import { jobCancel, jobPause } from "./api";

export type AudiPickOperationStatus = "running" | "completed" | "failed" | "cancelled";
export type AudiPickOperation = {
  id: string; label: string; message: string; current?: number; total?: number;
  status: AudiPickOperationStatus; controls: boolean; paused: boolean; stopping: boolean;
  controlError?: string;
};
export type AudiPickOperationHandle = {
  id: string;
  update: (message: string, current?: number, total?: number) => void;
  finish: (status: Exclude<AudiPickOperationStatus, "running">, message: string) => void;
  attachJob: (jobId: string) => void;
  detachJob: (jobId: string) => void;
  checkpoint: () => Promise<void>;
};
type Internal = { state: AudiPickOperation; jobs: Set<string>; wake: Set<() => void> };
const operations = new Map<string, Internal>();
// Keep ownership after completion: a late page event must not celebrate an entire contract.
const ownedJobs = new Set<string>();
const listeners = new Set<() => void>();
let snapshot: AudiPickOperation[] = [];
let sequence = 0;
function emit() { snapshot = [...operations.values()].map((value) => value.state); listeners.forEach((fn) => fn()); }
export function subscribeAudiPickOperations(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }
export function getAudiPickOperations() { return snapshot; }
export function useAudiPickOperations() { return useSyncExternalStore(subscribeAudiPickOperations, getAudiPickOperations, getAudiPickOperations); }
export function isAudiPickOperationJob(jobId: string) { return ownedJobs.has(jobId); }
export function hasActiveAudiPickOperation() { return snapshot.some((value) => value.status === "running"); }
function cancelled() { return new Error("识别已取消，已完成页已保存，可稍后继续。"); }

/** A UI lifecycle, not another execution engine: workers and persistence stay in the toolbox. */
export function beginAudiPickOperation(label: string, controls = false): AudiPickOperationHandle {
  const id = `audipick-operation-${++sequence}`;
  const item: Internal = { state: { id, label, message: "正在准备…", status: "running", controls, paused: false, stopping: false }, jobs: new Set(), wake: new Set() };
  operations.set(id, item); emit();
  return {
    id,
    update(message, current, total) {
      if (item.state.status !== "running") return;
      item.state = { ...item.state, message, current, total }; emit();
    },
    finish(status, message) {
      if (item.state.status !== "running") return;
      item.state = { ...item.state, status, message, paused: false }; item.wake.forEach((fn) => fn()); item.wake.clear(); emit();
    },
    attachJob(jobId) {
      ownedJobs.add(jobId); item.jobs.add(jobId); emit();
      if (item.state.stopping) void jobCancel(jobId).catch(() => controlFailure(item, "停止当前页失败，请重试。"));
      else if (item.state.paused) void jobPause(jobId, true).catch(() => controlFailure(item, "暂停当前页失败，请重试。"));
    },
    detachJob(jobId) { item.jobs.delete(jobId); },
    async checkpoint() {
      if (item.state.stopping) throw cancelled();
      while (item.state.paused && item.state.status === "running") await new Promise<void>((resolve) => item.wake.add(resolve));
      if (item.state.stopping || item.state.status === "cancelled") throw cancelled();
    },
  };
}
function controlFailure(item: Internal, message: string) { item.state = { ...item.state, controlError: message }; emit(); }
export async function setAudiPickOperationPaused(id: string, paused: boolean) {
  const item = operations.get(id); if (!item || !item.state.controls || item.state.status !== "running") return;
  const previous = item.state.paused;
  item.state = { ...item.state, paused, controlError: undefined }; emit();
  try { await Promise.all([...item.jobs].map((jobId) => jobPause(jobId, paused))); }
  catch { item.state = { ...item.state, paused: previous }; controlFailure(item, "暂停/继续未成功，请重试。"); }
  finally { item.wake.forEach((fn) => fn()); item.wake.clear(); }
}
export async function stopAudiPickOperation(id: string) {
  const item = operations.get(id); if (!item || !item.state.controls || item.state.status !== "running") return;
  item.state = { ...item.state, stopping: true, paused: false, controlError: undefined }; emit();
  item.wake.forEach((fn) => fn()); item.wake.clear();
  try { await Promise.all([...item.jobs].map((jobId) => jobCancel(jobId))); }
  catch { controlFailure(item, "停止当前页失败；已阻止下一页启动，可重试停止。"); }
}
export function dismissAudiPickOperation(id: string) {
  const item = operations.get(id); if (item && item.state.status !== "running") { operations.delete(id); emit(); }
}
export function dismissFinishedAudiPickOperations() {
  let changed = false;
  for (const [id, item] of operations) {
    if (item.state.status === "running") continue;
    operations.delete(id);
    changed = true;
  }
  if (changed) emit();
}

const QUIET_METHODS = new Set([
  "audipick.status", "audipick.config_status", "audipick.projects", "audipick.project_get", "audipick.project_list",
  "audipick.project_save", "audipick.document_text", "audipick.document_text_save", "audipick.rules", "audipick.rule_list",
]);
export function isAudiPickBusyManaged(method: string) {
  return QUIET_METHODS.has(method) || (method.startsWith("audipick.") && hasActiveAudiPickOperation()
    && !["audipick.export", "audipick.backup_export", "audipick.backup_import"].includes(method));
}
