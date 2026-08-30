import { Button } from "@/components/ui/button";
import { useJobOwnedByDialog } from "@/components/JobDialog";
import type { JobEvent } from "@/types";

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

  if (owned) return null;

  return (
    <div className={`job-progress ${compact ? "job-progress--compact" : ""}`}>
      <div className={`job-banner ${tone}`}>
        <strong>{job.message}</strong>
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
      <progress className={`progress-tone-${tone}`} max={max} value={value} />
    </div>
  );
}
