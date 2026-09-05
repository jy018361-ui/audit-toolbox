import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { jobCancel, jobPause } from "@/api";
import type { JobEvent } from "@/types";

/** 结束态的三个 phase 由 Rust 侧统一约定（excel_merger.rs）。 */
const FINISHED = ["completed", "failed", "cancelled"];

export function isJobRunning(job: JobEvent): boolean {
  return !FINISHED.includes(job.phase);
}

type JobDialogApi = {
  /** 弹窗此刻是否正展示该任务（最小化时为 false）。 */
  owns: (jobId: string) => boolean;
  isPaused: (jobId: string) => boolean;
  togglePause: (jobId: string) => void;
};

/**
 * 弹窗接管了哪些任务。页面里内联的 JobProgress 据此让位——同一个任务
 * 同时出现在弹窗和页面里会看着像跑了两遍。最小化时弹窗只剩右下角一条，
 * 这时把内联进度还给页面，用户仍能在原处看到细节。
 *
 * 暂停状态也挂在这里：Roll Forward 和 AudiPick 页面自己也有暂停按钮，
 * 两边各记一份迟早对不上（弹窗里暂停了，页面按钮还写着「暂停」）。
 */
const JobDialogContext = createContext<JobDialogApi>({
  owns: () => false,
  isPaused: () => false,
  togglePause: () => undefined,
});

/** 该任务此刻是否由弹窗展示（最小化时为 false）。 */
export function useJobOwnedByDialog(jobId: string | undefined): boolean {
  const { owns } = useContext(JobDialogContext);
  return jobId ? owns(jobId) : false;
}

/**
 * 暂停/继续的统一入口。页面上的暂停按钮走这里，状态就和弹窗是同一份。
 */
export function useJobPause(): Pick<JobDialogApi, "isPaused" | "togglePause"> {
  const { isPaused, togglePause } = useContext(JobDialogContext);
  return { isPaused, togglePause };
}

function percent(job: JobEvent): number {
  const max = Math.max(job.total, 1);
  return Math.round((Math.min(job.current, max) / max) * 100);
}

function toneOf(job: JobEvent): string {
  if (job.severity === "error") return "danger";
  if (job.severity === "warning") return "warning";
  if (job.severity === "success") return "success";
  return "info";
}

type JobRowProps = {
  job: JobEvent;
  label: string;
  paused: boolean;
  memoryPaused: boolean;
  onTogglePause: () => void;
  onStop: () => void;
};

function JobRow({ job, label, paused, memoryPaused, onTogglePause, onStop }: JobRowProps) {
  const pct = percent(job);
  const tone = toneOf(job);
  return (
    <section className="job-dialog-row" aria-label={`${label}任务进度`}>
      <div className="job-dialog-row-head">
        <strong>{label}</strong>
        <span className="job-pct">{memoryPaused ? "内存等待" : paused ? "已暂停" : job.total > 0 ? `${pct}%` : "处理中"}</span>
      </div>
      <p className="job-dialog-message" aria-live="polite" aria-atomic="true">{job.message}</p>
      <progress
        className={`progress-tone-${paused ? "warning" : tone}`}
        aria-label={`${label}进度`}
        max={Math.max(job.total, 1)}
        value={job.total > 0 ? Math.min(job.current, Math.max(job.total, 1)) : undefined}
      />
      <div className="job-dialog-row-actions">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onTogglePause}
        >
          {memoryPaused ? "尝试继续" : paused ? "继续" : "暂停"}
        </Button>
        <Button type="button" variant="destructive" size="sm" onClick={onStop}>
          停止
        </Button>
      </div>
    </section>
  );
}

export type JobDialogProviderProps = {
  /** App 收集到的全部任务事件（含已结束的，这里自行过滤）。 */
  jobs: JobEvent[];
  /** toolId → 面向用户的工具名。 */
  nameOf: (toolId: string) => string;
  children: React.ReactNode;
};

/**
 * 全局任务进度弹窗。任何后台任务一开始就弹出，显示进度并提供暂停/继续/停止；
 * 「最小化」把它收成右下角一条，用户可以切去别的工具，点小条再展开。
 *
 * 用户暂停在前端记录，以便任务停在后端检查点期间按钮仍保持正确状态；
 * 内存暂停则由后端事件驱动，达到安全回升线后会自动恢复。
 */
export function JobDialogProvider({
  jobs,
  nameOf,
  children,
}: JobDialogProviderProps) {
  const [minimized, setMinimized] = useState(false);
  const minimizedButtonRef = useRef<HTMLButtonElement>(null);
  const [paused, setPaused] = useState<Record<string, boolean>>({});
  const running = jobs.filter(isJobRunning);
  const runningIds = running.map((job) => job.jobId).join("|");

  // 任务跑完就把最小化和暂停记录归零：下一个任务应当重新弹出来，
  // 而不是继承上一次收起来的状态、让用户以为没在跑。
  useEffect(() => {
    if (runningIds === "") {
      setMinimized(false);
      setPaused((current) => (Object.keys(current).length ? {} : current));
    }
  }, [runningIds]);

  const owns = useCallback(
    (jobId: string) => !minimized && running.some((job) => job.jobId === jobId),
    // running 每次事件都是新数组，用 id 串做依赖，避免每帧重建导致下游重渲。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [minimized, runningIds],
  );

  const togglePause = (jobId: string) => {
    const memoryPaused = running.some(
      (job) => job.jobId === jobId && job.phase === "memory_paused",
    );
    const next = memoryPaused ? false : !paused[jobId];
    setPaused((current) => ({ ...current, [jobId]: next }));
    void jobPause(jobId, next).catch(() => {
      // 任务可能刚好结束；回滚状态，不打断用户。
      setPaused((current) => ({ ...current, [jobId]: !next }));
    });
  };

  const retryAfterMemoryPause = (jobId: string) => {
    setPaused((current) => ({ ...current, [jobId]: false }));
    void jobPause(jobId, false).catch(() => undefined);
  };

  const stop = (jobId: string) => {
    void jobCancel(jobId).catch(() => undefined);
  };

  const open = running.length > 0 && !minimized;
  const first = running[0];

  useEffect(() => {
    if (!minimized) return;
    // Radix 关闭弹窗时也会恢复焦点；下一帧再把焦点交给真正替代弹窗的任务条。
    const timer = window.setTimeout(() => minimizedButtonRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [minimized]);

  return (
    <JobDialogContext.Provider
      value={{
        owns,
        isPaused: (jobId) => Boolean(paused[jobId])
          || running.some((job) => job.jobId === jobId && job.phase === "memory_paused"),
        togglePause,
      }}
    >
      {children}
      <Dialog open={open}>
        <DialogContent
          showCloseButton={false}
          className="job-dialog"
          // 任务还在跑，ESC 和点击遮罩关掉弹窗只会让人以为任务停了。
          // 唯一的收起方式是「最小化」，唯一的终止方式是「停止」。
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>
              {running.length > 1
                ? `正在处理 ${running.length} 个任务`
                : "正在处理"}
            </DialogTitle>
            <DialogDescription>
              处理期间可以暂停，稍后从中断处继续；也可以最小化到右下角，先去用别的工具。
            </DialogDescription>
          </DialogHeader>
          <div className="job-dialog-rows" role="list" aria-label="进行中的任务">
            {running.map((job) => (
              <div role="listitem" key={job.jobId}>
                <JobRow
                  job={job}
                  label={nameOf(job.toolId)}
                  paused={Boolean(paused[job.jobId]) || job.phase === "memory_paused"}
                  memoryPaused={job.phase === "memory_paused"}
                  onTogglePause={() => job.phase === "memory_paused"
                    ? retryAfterMemoryPause(job.jobId)
                    : togglePause(job.jobId)}
                  onStop={() => stop(job.jobId)}
                />
              </div>
            ))}
          </div>
          <div className="job-dialog-footer">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setMinimized(true)}
            >
              最小化
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {running.length > 0 && minimized && first && (
        <button
          ref={minimizedButtonRef}
          type="button"
          className="job-dialog-pill"
          onClick={() => setMinimized(false)}
          aria-label={`展开任务进度：${
            running.length > 1 ? `${running.length} 个任务进行中` : nameOf(first.toolId)
          }`}
        >
          <span className="job-dialog-pill-dot" aria-hidden="true" />
          <span className="job-dialog-pill-text">
            {running.length > 1
              ? `${running.length} 个任务进行中`
              : `${nameOf(first.toolId)} · 点击展开`}
          </span>
          <span className="job-pct">
            {(paused[first.jobId] || first.phase === "memory_paused") && running.length === 1
              ? first.phase === "memory_paused" ? "内存等待" : "已暂停"
              : first.total > 0 ? `${percent(first)}%` : "处理中"}
          </span>
        </button>
      )}
    </JobDialogContext.Provider>
  );
}
