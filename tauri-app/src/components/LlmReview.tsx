import { Button } from "@/components/ui/button";

export type ReviewChange = {
  id: string;
  label: string;
  before?: string;
  after?: string;
  reason?: string;
  confidence?: number;
  attention?: boolean;
};

export type ReviewPending = {
  id: string;
  label: string;
  current?: string;
  suggested?: string;
  reason?: string;
  confidence?: number;
};

export type LlmReviewProps = {
  title: string;
  busy: boolean;
  passed?: boolean;
  enabled?: boolean;
  failed?: boolean;
  message?: string;
  detail?: string;
  summary?: string;
  changes: ReviewChange[];
  pending: ReviewPending[];
  onUndo: (change: ReviewChange) => void;
  onAccept: (item: ReviewPending) => void;
  onKeep: (item: ReviewPending) => void;
  onSkip: () => void;
  skipLabel?: string;
  closeFailedLabel?: string;
};

/**
 * 统一的 LLM 映射复核卡片。FA 主映射 / FA 补充清单 / 看账三处共用一个。
 * 视觉沿用 fa-llm-review 语义：变更行绿（attention 黄）、待定建议黄。
 */
export function LlmReview({
  title,
  busy,
  passed,
  enabled,
  failed,
  message,
  detail,
  summary,
  changes,
  pending,
  onUndo,
  onAccept,
  onKeep,
  onSkip,
  skipLabel = "停止并继续主流程",
  closeFailedLabel = "关闭失败提示",
}: LlmReviewProps) {
  const pill =
    busy
      ? "preview"
      : failed
        ? "warning"
        : passed === false
          ? "warning"
          : enabled
            ? "ready"
            : "";
  const pillText = busy
    ? "复核中"
    : failed
      ? "失败（不阻塞）"
      : passed === false
        ? "需人工复核"
        : enabled
          ? "已完成"
          : "未启用";

  return (
    <div className={`fa-llm-review ${passed === false ? "warning" : ""}`}>
      <div className="section-title">
        <h3>{title}</h3>
        <span className={`pill ${pill}`}>{pillText}</span>
      </div>
      <p>
        {busy ? "正在复核字段口径和匹配 ID；复核期间匹配键与字段映射已暂时锁定。" : message}
      </p>
      {detail ? (
        <details className="fa-llm-detail">
          <summary>技术详情（排查用）</summary>
          <p>{detail}</p>
        </details>
      ) : null}
      {(busy || failed) && (
        <div className="actions compact">
          <Button type="button" variant="secondary" size="sm" onClick={onSkip}>
            {busy ? skipLabel : closeFailedLabel}
          </Button>
        </div>
      )}
      {!!changes.length && summary && <p>{summary}</p>}
      {changes.map((change) => (
        <div
          className={`fa-review-item fa-change${change.attention ? " attention" : ""}`}
          key={change.id}
        >
          <strong>{change.label}</strong>
          {change.before !== undefined && (
            <span className="fa-change-diff">
              {change.before} → {change.after}
            </span>
          )}
          {!!change.reason && (
            <span>
              {change.reason}
              {change.confidence ? `（把握 ${Math.round(change.confidence * 100)}%）` : ""}
            </span>
          )}
          <div className="actions compact">
            <Button type="button" variant="secondary" size="xs" disabled={busy} onClick={() => onUndo(change)}>
              撤销
            </Button>
          </div>
        </div>
      ))}
      {pending.map((item) => (
        <div className="fa-review-item fa-pending" key={item.id}>
          <strong>
            {item.label}
            <em>把握不足，未改动</em>
          </strong>
          {item.current !== undefined && (
            <span className="fa-change-diff">
              {item.current} → {item.suggested}
            </span>
          )}
          {!!item.reason && (
            <span>
              {item.reason}
              {item.confidence ? `（把握 ${Math.round(item.confidence * 100)}%）` : ""}
            </span>
          )}
          <div className="actions compact">
            <Button type="button" variant="secondary" size="xs" disabled={busy} onClick={() => onAccept(item)}>
              采纳
            </Button>
            <Button type="button" variant="secondary" size="xs" disabled={busy} onClick={() => onKeep(item)}>
              保留当前
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
