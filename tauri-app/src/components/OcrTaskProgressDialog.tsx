import { useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import type { OcrTaskProgress } from "../ocrProgress";
import "./OcrScanProgressDialog.css";
import "./OcrTaskProgressDialog.css";

const phaseLabels = {
  preparing: "正在准备",
  extracting: "正在摘录",
  saving: "正在保存",
  exporting: "正在导出",
};

/** One visible lifecycle spans every model request, persistence and final export. */
export function OcrTaskProgressDialog({
  progress,
  obscured = false,
  raised = false,
}: {
  progress?: OcrTaskProgress;
  obscured?: boolean;
  raised?: boolean;
}) {
  const [minimized, setMinimized] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const pill = useRef<HTMLButtonElement>(null);
  const active = Boolean(progress);
  useEffect(() => {
    setMinimized(false);
    setElapsed(0);
    if (!active) return;
    const start = Date.now();
    const timer = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - start) / 1000)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [active]);
  useEffect(() => {
    if (!minimized) return;
    const timer = window.setTimeout(() => pill.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [minimized]);
  if (!progress) return null;
  const exporting = progress.phase === "exporting";
  const status = progress.stopping
    ? "正在取消"
    : progress.paused
      ? "已暂停"
      : phaseLabels[progress.phase];
  const activity = progress.activity;
  const activityCount =
    activity && activity.total > 0
      ? `${activity.completed} / ${activity.total}${exporting ? "" : " 段"}`
      : "等待处理结果";
  return (
    <>
      <Dialog open={!minimized && !obscured}>
        <DialogContent
          className="ocr-scan-dialog ocr-task-dialog"
          showCloseButton={false}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            setMinimized(true);
          }}
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <div className="ocr-scan-heading">
              <DialogTitle>OCR 摘录与导出</DialogTitle>
              <span className="ocr-scan-status" role="status">
                {status}
              </span>
            </div>
            <DialogDescription>
              分段摘录、保存和导出持续显示，可后台运行。
            </DialogDescription>
          </DialogHeader>
          <p className="ocr-scan-filename">{progress.fileName}</p>
          <div className="ocr-task-file-count">
            <strong>
              已处理 {progress.completed} / {progress.total} 份文件
            </strong>
            <span>已用时 {elapsed} 秒</span>
          </div>
          <progress
            className="ocr-scan-bar"
            aria-label="文件处理进度"
            max={Math.max(progress.total, 1)}
            value={progress.completed}
          />
          <div className="ocr-task-activity" aria-live="polite">
            <p>{progress.message}</p>
            <span>{activityCount}</span>
          </div>
          <div className="ocr-task-track">
            <progress
              className={`ocr-scan-bar ocr-task-wait${!progress.paused && !progress.stopping ? " is-working" : ""}${progress.paused ? " is-paused" : ""}`}
              aria-label={exporting ? "导出进度" : "分段摘录进度"}
              aria-valuetext={`${status} · ${activityCount}`}
              max={Math.max(activity?.total ?? 0, 1)}
              value={
                activity && activity.total > 0 ? activity.completed : undefined
              }
            />
          </div>
          {!progress.paused && !progress.stopping && (
            <p className="ocr-task-wait-note">
              {exporting
                ? "正在生成 Excel，文件写入完成后显示导出结果。"
                : "等待模型返回时耗时会继续更新，每段核验完成后推进进度。"}
            </p>
          )}
          {progress.error && (
            <p className="ocr-scan-failed" role="alert">
              {progress.error}
            </p>
          )}
          <div className="ocr-scan-footer">
            <span>已保存的摘录结果会保留</span>
            <div>
              <Button
                variant="ghost"
                size="sm"
                disabled={
                  progress.controlling || (progress.stopping && !progress.error)
                }
                onClick={progress.onCancel}
              >
                {progress.stopping
                  ? progress.error
                    ? "重试取消"
                    : "正在取消…"
                  : "取消任务"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setMinimized(true)}
              >
                后台运行
              </Button>
              <Button
                size="sm"
                disabled={progress.controlling || progress.stopping}
                onClick={progress.onPause}
              >
                {progress.controlling
                  ? "请稍候…"
                  : progress.paused
                    ? "继续"
                    : "暂停"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      {(minimized || obscured) && (
        <button
          ref={pill}
          type="button"
          className={`ocr-scan-pill${raised ? " is-raised" : ""}`}
          aria-label="展开 OCR 摘录与导出进度"
          onClick={() => setMinimized(false)}
        >
          <strong>OCR · {status}</strong>
          <span>
            已处理 {progress.completed} / {progress.total} 份 · 已用时 {elapsed}{" "}
            秒
          </span>
          <div className="ocr-task-track">
            <progress
              className={`ocr-task-wait${!progress.paused && !progress.stopping ? " is-working" : ""}`}
              aria-label="后台摘录与导出进度"
              max={Math.max(activity?.total ?? 0, 1)}
              value={
                activity && activity.total > 0 ? activity.completed : undefined
              }
            />
          </div>
        </button>
      )}
    </>
  );
}
