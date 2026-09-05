import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CircleCheck } from "lucide-react";
import { openOutput } from "@/api";
import type { JobEvent } from "@/types";
import { loadTourState } from "./tourState";
import "./success-nudge.css";

type SuccessNudgeProps = {
  /** App 收集到的全部任务事件（含已结束的，这里只关心 completed 的那些）。 */
  jobs: JobEvent[];
  /** toolId → 面向用户的工具名。 */
  toolNameOf: (toolId: string) => string;
  /** 测试可注入：卡片自动消失的毫秒数，默认 6 秒。 */
  autoDismissMs?: number;
};

/**
 * 导出完成的轻量成功反馈（新手模式）：任务跑完的瞬间在屏幕底部弹一张
 * 小卡片——打勾 + 「打开结果」/「返回工作台」，几秒自动消失。
 * 任务进度细节仍由 JobDialog / JobProgress 负责，这里只补"成功了，接下来去哪"。
 */
export function SuccessNudge({
  jobs,
  toolNameOf,
  autoDismissMs = 6000,
}: SuccessNudgeProps) {
  const [celebrating, setCelebrating] = useState<JobEvent | null>(null);
  const [pauseDismiss, setPauseDismiss] = useState(false);
  // 已经庆祝过的 jobId：同一任务只庆祝一次，事件流里 completed 事件重复推送也不重弹。
  const celebratedIds = useRef<Set<string>>(new Set());
  const navigate = useNavigate();

  useEffect(() => {
    // 新手模式总开关关闭时不弹（与 StepTourHint 同一判断口径，读 localStorage 即时生效）。
    if (loadTourState().newbieMode === false) return;
    // 多个任务接连完成时直接显示最新的一个，旧的被覆盖、不排队轰炸。
    const next = [...jobs]
      .reverse()
      .find(
        (job) =>
          job.phase === "completed" && !celebratedIds.current.has(job.jobId),
      );
    if (!next) return;
    celebratedIds.current.add(next.jobId);
    setCelebrating(next);
  }, [jobs]);

  useEffect(() => {
    if (!celebrating || pauseDismiss) return;
    const timer = window.setTimeout(() => setCelebrating(null), autoDismissMs);
    return () => window.clearTimeout(timer);
  }, [celebrating, autoDismissMs, pauseDismiss]);

  if (!celebrating) return null;
  // 打开结果只在确有输出文件时提供；路径由 openOutput 走白名单校验，失败保持安静。
  const outputPath = celebrating.outputPaths[0];
  return (
    <div
      className="success-nudge"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      key={celebrating.jobId}
      onMouseEnter={() => setPauseDismiss(true)}
      onMouseLeave={() => setPauseDismiss(false)}
      onFocusCapture={() => setPauseDismiss(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setPauseDismiss(false);
        }
      }}
    >
      <span className="success-nudge-icon" aria-hidden="true">
        <CircleCheck size={18} />
      </span>
      <p className="success-nudge-text">
        {toolNameOf(celebrating.toolId)}已完成
      </p>
      <div className="success-nudge-actions">
        {outputPath && (
          <button
            type="button"
            className="success-nudge-btn success-nudge-btn-primary"
            onClick={() => {
              void openOutput(outputPath).catch(() => {
                // 文件可能已被移动/删除；打不开时不出错弹窗，卡片稍后自行消失。
              });
            }}
          >
            打开结果
          </button>
        )}
        <button
          type="button"
          className="success-nudge-btn"
          onClick={() => {
            setCelebrating(null);
            navigate("/");
          }}
        >
          返回工作台
        </button>
      </div>
      <button
        type="button"
        className="success-nudge-close"
        aria-label="关闭完成提示"
        onClick={() => setCelebrating(null)}
      >
        ×
      </button>
    </div>
  );
}
