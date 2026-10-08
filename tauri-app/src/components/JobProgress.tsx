import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useJobOwnedByDialog } from "@/components/JobDialog";
import { errorText, isJobGone } from "@/lib/errors";
import type { JobEvent } from "@/types";
import { jobPresentation } from "@/jobState";
import "./task-state.css";

export type JobProgressProps = {
  job: JobEvent;
  /** 任务失败的具体原因，若与进度消息不同则在同一状态区展示。 */
  detail?: string;
  onCancel?: (jobId: string) => void | boolean | Promise<void | boolean>;
  /** 取消按钮文案，统一为 "取消任务" */
  cancelLabel?: string;
  compact?: boolean;
};

export function terminalJobError(job?: JobEvent): string {
  if (!job || (job.phase !== "failed" && job.phase !== "cancelled")) return "";
  const result = job.result as { error?: unknown } | undefined;
  return result?.error ? errorText(result.error) : job.message;
}

/**
 * 状态与进度的统一文案口径（P2-3 / P3-13）：内联进度条与右下角悬浮胶囊共用，
 * 避免两边各自翻译出现“页内排队中、胶囊处理中”的矛盾。映射：
 * queued=排队中、running=处理中、completed=已完成、failed=处理失败、cancelled=已取消；
 * 总量未知（total≤0）时百分比无从计算，只报状态词。
 */
export function jobStatusText(job: JobEvent): string {
  const presentation = jobPresentation(job);
  return presentation.percent === null
    ? presentation.label
    : `${presentation.label} ${presentation.percent}%`;
}

/**
 * 统一的任务进度条。取代此前 5 套重复实现（.job-progress / .confirmation-job /
 * .kz-progress / .fa-inline-progress / .merger-progress）。
 * 按 job.severity 着色：info→中性、warning→黄、error→红、success→绿。
 * 内部 phase（read/movement/completed 等）是英文技术词，不展示给用户。
 */
export function JobProgress({
  job,
  detail,
  onCancel,
  cancelLabel = "取消任务",
  compact = false,
}: JobProgressProps) {
  const [cancelPending, setCancelPending] = useState(false);
  const [cancelError, setCancelError] = useState("");
  async function cancel() {
    if (!onCancel || cancelPending) return;
    setCancelPending(true);
    setCancelError("");
    try {
      const accepted = await onCancel(job.jobId);
      if (accepted === false) throw new Error("任务可能已结束，取消指令未被接受。请检查任务状态后重试。");
    } catch (error) {
      setCancelError(
        isJobGone(error)
          ? "任务可能已结束，取消指令未被接受。请检查任务状态后重试。"
          : `取消失败：${errorText(error)}`,
      );
    } finally {
      setCancelPending(false);
    }
  }
  // 全局弹窗或最小化任务条接管时让位，同一进度只呈现一次。
  const owned = useJobOwnedByDialog(job.jobId);
  const total = Number.isFinite(job.total) ? Math.max(job.total, 0) : 0;
  const max = Math.max(total, 1);
  const presentation = jobPresentation(job);
  // P2-2：消息与状态徽标输出同一状态词时（“排队中 排队中”“处理中 处理中”）只渲染
  // 一次——消息区优先展示业务阶段文案，状态词只在消息缺失或不同时出现。
  const message = job.message && job.message !== presentation.label ? job.message : "";
  const value = Math.max(
    0,
    Math.min(job.current, presentation.terminal ? max : max * 0.99),
  );

  if (owned) return null;

  return (
    <div
      className={`job-progress ${compact ? "job-progress--compact" : ""}`}
      role={presentation.state === "failed" ? "alert" : "status"}
      aria-live={presentation.state === "failed" ? "assertive" : "polite"}
      data-job-state={presentation.state}
    >
      <div className={`job-banner ${presentation.tone}`}>
        <strong className="job-progress-copy">
          {presentation.tone === "success" && (
            <span className="job-done-check" aria-hidden="true">
              <svg viewBox="0 0 16 16">
                <path
                  d="M3 8.5 6.5 12 13 4.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
          )}
          <span className="job-progress-message">{message || presentation.label}</span>
        </strong>
        {message && <span className="job-progress-state">{presentation.label}</span>}
        {presentation.percent !== null && (
          <span className="job-pct">{presentation.percent}%</span>
        )}
        {onCancel && !presentation.terminal && (
          <Button
            variant="ghost"
            size="xs"
            type="button"
            className="job-cancel"
            onClick={() => void cancel()}
            disabled={cancelPending}
          >
            {cancelPending ? "正在取消…" : cancelLabel}
          </Button>
        )}
      </div>
      {detail && detail !== job.message && (
        <p className="job-progress-error">{detail}</p>
      )}
      {cancelError && <p className="job-progress-error" role="alert">{cancelError}</p>}
      {!presentation.terminal && (
        <progress
          aria-label={`${presentation.label}进度`}
          className={`progress-tone-${presentation.tone}`}
          max={max}
          value={total > 0 ? value : undefined}
        />
      )}
    </div>
  );
}
