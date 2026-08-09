import { Button } from "@/components/ui/button";
import type { JobEvent } from "@/types";

export type JobProgressProps = {
  job: JobEvent;
  onCancel?: (jobId: string) => void;
  /** 取消按钮文案，统一为 "取消任务" */
  cancelLabel?: string;
  showPhase?: boolean;
  compact?: boolean;
};

/**
 * 统一的任务进度条。取代此前 5 套重复实现（.job-progress / .confirmation-job /
 * .kz-progress / .fa-inline-progress / .merger-progress）。
 * 按 job.severity 着色：info→中性、warning→黄、error→红、success→绿。
 */
export function JobProgress({
  job,
  onCancel,
  cancelLabel = "取消任务",
  showPhase = true,
  compact = false,
}: JobProgressProps) {
  const max = Math.max(job.total, 1);
  const value = Math.min(job.current, max);
  const pct = Math.round((value / max) * 100);
  const tone =
    job.severity === "error"
      ? "danger"
      : job.severity === "warning"
        ? "warning"
        : job.severity === "success"
          ? "success"
          : "info";

  return (
    <div className={`job-progress ${compact ? "job-progress--compact" : ""}`}>
      <div className={`job-banner ${tone}`}>
        <strong>{job.message}</strong>
        {showPhase && job.phase && <span className="job-phase">{job.phase}</span>}
        <span className="job-pct">{pct}%</span>
        {onCancel && (
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
      <progress
        className={`progress-tone-${tone}`}
        max={max}
        value={value}
      />
    </div>
  );
}
