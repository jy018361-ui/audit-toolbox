import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Pause, Play } from "lucide-react";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import type { OcrScanProgress, OcrScanPageState } from "../ocrProgress";
import "./OcrScanProgressDialog.css";

const pageLabels: Record<OcrScanPageState, string> = {
  preparing: "准备中",
  running: "识别中",
  queued: "排队中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  memory_paused: "等待内存恢复",
};

export function OcrScanProgressDialog({
  progress,
  obscured = false,
  raised = false,
}: {
  progress?: OcrScanProgress;
  obscured?: boolean;
  raised?: boolean;
}) {
  const [minimized, setMinimized] = useState(false);
  const [details, setDetails] = useState(false);
  const pill = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!progress) {
      setMinimized(false);
      setDetails(false);
    }
  }, [Boolean(progress)]);
  useEffect(() => {
    if (!minimized) return;
    const timer = window.setTimeout(() => pill.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [minimized]);
  if (!progress) return null;
  const { total, completed, pages } = progress;
  const failed = pages.filter((page) => page.state === "failed").length;
  const succeeded = pages.filter((page) => page.state === "completed").length;
  const active = pages.filter((page) =>
    ["running", "queued", "preparing", "memory_paused"].includes(page.state),
  ).length;
  const status = progress.stopping
    ? "正在取消"
    : progress.paused
      ? "已暂停"
      : progress.phase === "preparing"
        ? "正在准备"
        : progress.phase === "saving"
          ? "正在保存"
          : "正在识别";
  const known = progress.phase !== "preparing";
  const count = known
    ? total > 0
      ? `${completed} / ${total} 页`
      : "没有待扫描页"
    : "正在确认页数";
  const disabled = progress.controlling || progress.stopping;
  return (
    <>
      <Dialog open={!minimized && !obscured}>
        <DialogContent
          className="ocr-scan-dialog"
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
              <DialogTitle>扫描文件</DialogTitle>
              <span className="ocr-scan-status" role="status">
                {status}
              </span>
            </div>
            <DialogDescription>
              第 {progress.fileIndex} / {progress.fileCount} 份文件
            </DialogDescription>
          </DialogHeader>
          <p className="ocr-scan-filename" title={progress.fileName}>
            {progress.fileName}
          </p>
          <div className="ocr-scan-count" aria-live="polite">
            <span>{known ? (total > 0 ? completed : "无需重扫") : "—"}</span>
            <span>
              {known
                ? total > 0
                  ? `/ ${total} 页`
                  : "没有待扫描页"
                : "正在确认页数"}
            </span>
            {known && total > 0 && (
              <span className="ocr-scan-count-label">本文件已处理</span>
            )}
          </div>
          <progress
            className={`ocr-scan-bar${progress.paused ? " is-paused" : ""}`}
            aria-label="本文件扫描进度"
            max={Math.max(total, 1)}
            value={known ? completed : undefined}
          />
          <div className="ocr-scan-summary">
            <span>
              成功 {succeeded} 页
              {failed > 0 && (
                <span className="ocr-scan-failed"> · 失败 {failed} 页</span>
              )}
            </span>
            <span>
              {active > 0
                ? `${active} 页${progress.stopping ? "正在取消" : progress.paused ? "已暂停" : "处理中"}`
                : status}
            </span>
          </div>
          <button
            type="button"
            className="ocr-scan-details-toggle"
            aria-expanded={details}
            aria-controls="ocr-scan-page-details"
            onClick={() => setDetails(!details)}
          >
            {details ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            {details ? "收起逐页状态" : "查看逐页状态"}
          </button>
          {details && (
            <div
              id="ocr-scan-page-details"
              className="ocr-scan-page-details"
              aria-label="逐页扫描状态"
            >
              {pages.length ? (
                pages.map((page) => (
                  <div key={page.page}>
                    <span>第 {page.page} 页</span>
                    <span
                      className={
                        page.state === "failed" ? "ocr-scan-failed" : ""
                      }
                    >
                      {progress.paused &&
                      ["running", "preparing", "queued"].includes(page.state)
                        ? "已暂停"
                        : pageLabels[page.state]}
                    </span>
                  </div>
                ))
              ) : (
                <p>正在准备扫描件…</p>
              )}
            </div>
          )}
          {progress.error && (
            <p className="ocr-scan-failed" role="alert">
              {progress.error}
            </p>
          )}
          <div className="ocr-scan-footer">
            <span>已完成页自动保存</span>
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
                  : "取消扫描"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setMinimized(true)}
              >
                后台运行
              </Button>
              <Button size="sm" disabled={disabled} onClick={progress.onPause}>
                {progress.paused ? <Play /> : <Pause />}
                {progress.controlling
                  ? "请稍候…"
                  : progress.paused
                    ? "继续扫描"
                    : "暂停"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      {(minimized || obscured) && (
        <button
          type="button"
          className={`ocr-scan-pill${raised ? " is-raised" : ""}`}
          ref={pill}
          onClick={() => setMinimized(false)}
          aria-label="展开 OCR 扫描进度"
        >
          <strong>OCR 扫描 · {status}</strong>
          <span>
            第 {progress.fileIndex} / {progress.fileCount} 份 · {count}
          </span>
          <progress
            aria-label="后台扫描进度"
            max={Math.max(total, 1)}
            value={known ? completed : undefined}
          />
        </button>
      )}
    </>
  );
}
