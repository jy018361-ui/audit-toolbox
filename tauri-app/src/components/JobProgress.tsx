import { Button } from "@/components/ui/button";
import { useJobOwnedByDialog } from "@/components/JobDialog";
import type { JobEvent } from "@/types";
import { jobPresentation } from "@/jobState";
import "./task-state.css";

export type JobProgressProps = {
  job: JobEvent;
  onCancel?: (jobId: string) => void;
  /** 取消按钮文案，统一为 "取消任务" */
  cancelLabel?: string;
  compact?: boolean;
};

/**
 * 统一的任务进度条。取代此前 5 套重复实现（.job-progress / .confirmation-job /
 * .kz-progress / .fa-inline-progress / .merger-progress）。
 * 按 job.severity 着色：info→中性、warning→黄、error→红、success→绿。
 * 内部 phase（read/movement/completed 等）是英文技术词，不展示给用户。
 */
export function JobProgress({
  job,
  onCancel,
  cancelLabel = "取消任务",
  compact = false,
}: JobProgressProps) {
  // 进度弹窗正展示同一个任务时这里让位，免得一个任务看着像跑了两遍。
  // 弹窗最小化后 owned 转 false，内联进度条回到页面上。
  const owned = useJobOwnedByDialog(job.jobId);
  const max = Math.max(job.total, 1);
  const value = Math.max(0, Math.min(job.current, max));
  const presentation = jobPresentation(job);

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
          <span className="job-progress-message">{job.message || presentation.label}</span>
        </strong>
        <span className="job-progress-state">{presentation.label}</span>
        <span className="job-pct">
          {presentation.percent === null ? presentation.label : `${presentation.percent}%`}
        </span>
        {onCancel && !presentation.terminal && (
          <Button
            variant="ghost"
            size="xs"
            type="button"
            className="job-cancel"
            onClick={() => onCancel(job.jobId)}
          >
            {cancelLabel}
          </Button>
        )}
      </div>
      {!presentation.terminal && (
        <progress
          aria-label={`${presentation.label}进度`}
          className={`progress-tone-${presentation.tone}`}
          max={max}
          value={job.total > 0 ? value : undefined}
        />
      )}
    </div>
  );
}
