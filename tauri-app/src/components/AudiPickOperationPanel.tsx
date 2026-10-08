import { useState } from "react";
import { Button } from "./ui/button";
import {
  dismissFinishedAudiPickOperations,
  setAudiPickOperationPaused,
  stopAudiPickOperation,
  useAudiPickOperations,
} from "../audipickOperation";
import "./audipick-operation.css";

const DETAILS_ID = "audipick-operation-details";

/** Non-modal, stable through page/chunk idle gaps. Only user actions expand it. */
export function AudiPickOperationPanel({
  raised = false,
}: {
  raised?: boolean;
}) {
  const operations = useAudiPickOperations();
  const [expanded, setExpanded] = useState(false);
  if (!operations.length) return null;
  const running = operations.filter((item) => item.status === "running");
  const finished = operations.filter((item) => item.status !== "running");
  const first = running[0] ?? operations[operations.length - 1];
  const compactOperation = running.find((item) => item.controls);
  const status =
    first.status === "failed"
      ? "未完成"
      : first.status === "cancelled"
        ? "已停止"
        : first.status === "completed"
          ? "已完成"
          : first.stopping
            ? "正在停止"
            : first.paused
              ? "已暂停"
              : "处理中";
  const summary = running.length
    ? operations.length === 1
      ? first.label
      : `AudiPick · ${running.length} 项处理中${finished.length ? ` · ${finished.length} 项已结束` : ""}`
    : operations.length === 1
      ? first.label
      : `${finished.length} 项已结束`;
  const panelClass = `audipick-operation-panel ${expanded ? "audipick-operation-expanded" : "audipick-operation-compact"}${raised ? " audipick-operation-raised" : ""}`;
  return (
    <aside className={panelClass} aria-label="AudiPick 后台任务">
      <div className="audipick-operation-heading">
        <div className="audipick-operation-summary-copy">
          <strong>{summary}</strong>
          <span className="audipick-operation-summary-line">
            <span role="status">{status}</span>
            <span aria-hidden="true"> · </span>
            <span
              className="audipick-operation-summary-message"
              title={first.message}
            >
              {first.message}
            </span>
          </span>
        </div>
        <div className="audipick-operation-heading-actions">
          {!expanded && compactOperation && (
            <>
              <Button
                size="sm"
                variant="secondary"
                disabled={compactOperation.stopping}
                onClick={() =>
                  void setAudiPickOperationPaused(
                    compactOperation.id,
                    !compactOperation.paused,
                  )
                }
              >
                {compactOperation.paused ? "继续" : "暂停"}
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={compactOperation.stopping}
                onClick={() => void stopAudiPickOperation(compactOperation.id)}
              >
                终止
              </Button>
            </>
          )}
          <Button
            size="sm"
            variant="secondary"
            aria-controls={DETAILS_ID}
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "收起" : "查看详情"}
          </Button>
          {!expanded && finished.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              onClick={dismissFinishedAudiPickOperations}
            >
              清除已结束（{finished.length}）
            </Button>
          )}
        </div>
      </div>
      <div id={DETAILS_ID}>
        {expanded && (
          <>
            <div className="audipick-operation-details">
              {operations.map((item) => (
                <section key={item.id} aria-label={item.label}>
                  <strong>{item.label}</strong>
                  <p>{item.message}</p>
                  {item.status === "running" && item.total && item.total > 0 ? (
                    <progress
                      aria-label={`${item.label}整体进度`}
                      max={item.total}
                      value={Math.min(item.current ?? 0, item.total * 0.99)}
                    />
                  ) : null}
                  {item.controlError && <p role="alert">{item.controlError}</p>}
                  {item.status === "running" && item.controls && (
                    <div className="audipick-operation-actions">
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={item.stopping}
                        onClick={() =>
                          void setAudiPickOperationPaused(item.id, !item.paused)
                        }
                      >
                        {item.paused ? "继续" : "暂停"}
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={item.stopping}
                        onClick={() => void stopAudiPickOperation(item.id)}
                      >
                        终止
                      </Button>
                    </div>
                  )}
                </section>
              ))}
            </div>
            {finished.length > 0 && (
              <div className="audipick-operation-footer">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={dismissFinishedAudiPickOperations}
                >
                  清除已结束（{finished.length}）
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
