import type { JobEvent } from "./types";

export const TERMINAL_JOB_PHASES = ["completed", "failed", "cancelled"] as const;

export type JobUiState =
  | "queued"
  | "running"
  | "paused"
  | "cancelled"
  | "failed"
  | "completed"
  | "partial";

export type JobPresentation = {
  state: JobUiState;
  label: string;
  tone: "info" | "warning" | "danger" | "success";
  terminal: boolean;
  percent: number | null;
};

const PARTIAL_RESULT_KEYS = [
  "warnings",
  "missing",
  "skippedPaths",
  "unmatchedSectionOrders",
  "outlookDifferences",
] as const;

function nonEmptyList(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

/**
 * 后端 phase 还包含 read/map/export 等业务步骤。页面不直接翻译这些技术词，
 * 而是归一成稳定的 UI 状态；“部分完成”由完成事件里的可复核结果判定。
 */
export function jobPresentation(job: JobEvent): JobPresentation {
  const result =
    job.result && typeof job.result === "object"
      ? (job.result as Record<string, unknown>)
      : undefined;
  const partial =
    job.phase === "completed" &&
    (job.severity === "warning" ||
      Boolean(result && PARTIAL_RESULT_KEYS.some((key) => nonEmptyList(result[key]))) ||
      result?.valid === false);
  const max = Math.max(job.total, 1);
  const calculatedPercent =
    job.total > 0
      ? Math.round((Math.max(0, Math.min(job.current, max)) / max) * 100)
      : null;
  // 阶段计数走完后仍可能有写盘、校验或原子替换。结束事件抵达前保留 1%，
  // 避免用户看到“100%”却仍需等待。
  const percent = calculatedPercent === null
    ? null
    : TERMINAL_JOB_PHASES.includes(job.phase as (typeof TERMINAL_JOB_PHASES)[number])
      ? calculatedPercent
      : Math.min(calculatedPercent, 99);

  if (job.phase === "failed")
    return { state: "failed", label: "处理失败", tone: "danger", terminal: true, percent };
  if (job.phase === "cancelled")
    return { state: "cancelled", label: "已取消", tone: "warning", terminal: true, percent };
  if (partial)
    return { state: "partial", label: "部分完成", tone: "warning", terminal: true, percent };
  if (job.phase === "completed")
    return { state: "completed", label: "已完成", tone: "success", terminal: true, percent };
  if (job.phase === "memory_paused" || job.phase === "paused")
    return { state: "paused", label: "已暂停", tone: "warning", terminal: false, percent };
  if (job.phase === "queued")
    return { state: "queued", label: "排队中", tone: "info", terminal: false, percent };
  return { state: "running", label: "处理中", tone: job.severity === "warning" ? "warning" : job.severity === "error" ? "danger" : "info", terminal: false, percent };
}

export function isTerminalJob(job: Pick<JobEvent, "phase">): boolean {
  return TERMINAL_JOB_PHASES.includes(
    job.phase as (typeof TERMINAL_JOB_PHASES)[number],
  );
}
