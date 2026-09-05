import { useEffect, useRef, useState } from "react";
import { loadTourState } from "./tourState";
import { useCurrentToolId } from "./ToolTourContext";
import { TOOL_TOUR_SCRIPTS } from "./toolTourContent";
import "./beginner-tour.css";

type HintStep = { key: string; label: string; disabled?: boolean };

/**
 * 工具内的分步提示（新手模式）：步骤条切换到某一步时，在该步骤条下方
 * 弹出一张小卡片，说明当前是第几步、这一步叫什么、做完怎么继续。
 * 挂在 StepIndicator 内部——18 个工具共用步骤条，一处接入全部生效。
 * 几秒后自动消失，也可手动关闭；总开关关闭时不弹。
 */
export function StepTourHint({
  steps,
  current,
  autoDismissMs = 6000,
}: {
  steps: HintStep[];
  current: number;
  /** 测试可注入：提示自动消失的毫秒数。 */
  autoDismissMs?: number;
}) {
  const [hint, setHint] = useState<{ index: number; nonce: number } | null>(
    null,
  );
  const previousCurrent = useRef(current);
  const toolId = useCurrentToolId();

  useEffect(() => {
    if (current === previousCurrent.current) return;
    previousCurrent.current = current;
    // 总开关关闭、或完整引导正在播放时不叠加提示。
    if (loadTourState().newbieMode === false) return;
    if (document.querySelector(".tour-layer")) return;
    const step = steps[current];
    if (!step || step.disabled) return;
    setHint({ index: current, nonce: Date.now() });
  }, [current, steps]);

  useEffect(() => {
    if (!hint) return;
    const timer = window.setTimeout(() => setHint(null), autoDismissMs);
    return () => window.clearTimeout(timer);
  }, [hint, autoDismissMs]);

  if (!hint) return null;
  const step = steps[hint.index];
  if (!step) return null;
  const isLast = hint.index === steps.length - 1;
  // 优先用针对性文案（toolTourContent.ts 按 工具id + 步骤key 逐条编写），
  // 没有对应的条目才落到通用文案。
  const specific = toolId
    ? TOOL_TOUR_SCRIPTS[toolId]?.stepHints?.[step.key]
    : undefined;
  return (
    <div className="step-hint" role="status" key={hint.nonce}>
      <p className="step-hint-count">
        第 {hint.index + 1} 步 · 共 {steps.length} 步
      </p>
      <strong className="step-hint-title">{step.label}</strong>
      <p className="step-hint-body">
        {specific ??
          (isLast
            ? "最后一步：完成它就能看到结果。想改前面的内容，点步骤条随时回去。"
            : "完成这一步的操作后，点「下一步」或步骤条继续；想改前面的内容，随时点回去。")}
      </p>
      <button
        type="button"
        className="step-hint-close"
        aria-label="关闭本步提示"
        onClick={() => setHint(null)}
      >
        ×
      </button>
    </div>
  );
}
