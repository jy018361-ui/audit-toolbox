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
  message?: string;
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
  const tbjeGroups = job.toolId === "tbje_check" ? result?.groups ?? result?.exports : undefined;
  const failedGroups = Array.isArray(tbjeGroups)
    ? tbjeGroups.filter((group) => group?.ok === false).length : 0;
  const batchTotal = Array.isArray(tbjeGroups) ? tbjeGroups.length : 0;
  const unresolvedDepositRates = job.toolId === "deposit_interest" && Array.isArray(result?.rows)
    ? result.rows.filter((row) => row && typeof row === "object" && (row as Record<string, unknown>).rateResolved === false).length
    : 0;
  if (job.phase === "completed" && unresolvedDepositRates > 0) {
    return {
      state: "partial", label: "待补利率", tone: "warning", terminal: true,
      percent: null,
      message: `已生成测算结果；${unresolvedDepositRates} 个账户利率待补，请补齐后重算。`,
    };
  }
  if (job.phase === "completed" && failedGroups > 0) {
    const succeeded = batchTotal - failedGroups;
    return succeeded === 0
      ? { state: "failed", label: "处理失败", tone: "danger", terminal: true, percent: null,
          message: `处理失败：共 ${batchTotal} 组，均未成功处理，请检查各组原因后重试。` }
      : { state: "partial", label: "部分完成", tone: "warning", terminal: true,
          percent: Math.min(99, Math.round(succeeded / batchTotal * 100)),
          message: `部分完成：已处理 ${succeeded} / ${batchTotal} 组，${failedGroups} 组未成功，请检查各组原因后重试。` };
  }
  const max = Math.max(job.total, 1);
  const calculatedPercent =
    job.total > 0
      ? Math.round((Math.max(0, Math.min(job.current, max)) / max) * 100)
      : null;
  // 阶段计数走完后仍可能有写盘、校验或原子替换。结束事件抵达前保留 1%，
  // 避免用户看到“100%”却仍需等待。
  const percent = job.phase === "failed" || job.phase === "cancelled"
    ? null
    : calculatedPercent === null
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
