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
import { isActiveOcrScanPage, type OcrScanProgress, type OcrScanPageState } from "../ocrProgress";
import "./OcrScanProgressDialog.css";

const pageLabels: Record<OcrScanPageState, string> = {
  preparing: "准备中",
  running: "识别中",
  ocr_request: "等待识别服务返回",
  ocr_save: "保存中",
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
  const [now, setNow] = useState(() => performance.now());
  const pill = useRef<HTMLButtonElement>(null);
  const visible = Boolean(progress);
  useEffect(() => {
    if (!visible) return;
    setNow(performance.now());
    const timer = window.setInterval(() => setNow(performance.now()), 1000);
    return () => window.clearInterval(timer);
  }, [visible]);
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
  const activePages = pages.filter(isActiveOcrScanPage);
  const active = activePages.length;
  const elapsed = (startedAt?: number) => startedAt === undefined ? undefined : Math.max(0, Math.floor((now - startedAt) / 1000));
  const slow = !progress.paused && !progress.stopping && activePages.some(page => (elapsed(page.startedAt) ?? 0) >= 30);
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
          {active > 0 && (
            <div className="ocr-scan-active-pages" aria-label="仍在处理的页面">
              <p>仍在处理：{activePages.map(page => `第 ${page.page} 页`).join("、")}</p>
              {activePages.map(page => (
                <div key={page.page}>
                  <span>
                    第 {page.page} 页 · {page.cancelling || progress.stopping ? "正在取消" : progress.paused ? "已暂停" : pageLabels[page.state]}
                    {page.startedAt !== undefined && ` · 已用时 ${elapsed(page.startedAt)} 秒（含暂停）`}
                  </span>
                  {progress.onDeferPage && page.cancellable && (elapsed(page.startedAt) ?? 0) >= 30 && (
                    <Button variant="outline" size="sm"
                      disabled={disabled || progress.paused || page.cancelling}
                      aria-label={`结束第 ${page.page} 页等待，稍后补扫`}
                      onClick={() => progress.onDeferPage?.(page.page)}>
                      {page.cancelling ? "正在取消…" : "结束此页等待"}
                    </Button>
                  )}
                </div>
              ))}
              {slow && <p className="ocr-scan-slow-note">
                部分页面耗时较长，完成数量不代表当前页码。可继续等待，或结束该页等待后重试失败页；已保存页会保留，不会自动重复请求。结束本机等待不保证服务端停止计费。
              </p>}
            </div>
          )}
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
                      isActiveOcrScanPage(page) && page.state !== "memory_paused"
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
          {active > 0 && <span>仍在处理：{activePages.map(page => `第 ${page.page} 页`).join("、")}</span>}
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
