import { Fragment, useEffect, useRef, useState } from "react";
import { loadTourState } from "./tourState";
import { useCurrentToolId } from "./ToolTourContext";
import { TOOL_TOUR_SCRIPTS } from "./toolTourContent";
import "./beginner-tour.css";

type HintStep = { key: string; label: string; disabled?: boolean };

type Rect = { top: number; left: number; width: number; height: number };

const SPOTLIGHT_PAD = 6;

/** keep-alive 隐藏页宽高为 0，据此排除，只锁定可见的步骤条。 */
function isVisibleIndicator(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  return rect.width >= 2 && rect.height >= 2;
}

/**
 * 工具内的分步提示（新手模式）：步骤条切换到某一步时，弹出一张小卡片，
 * 说明当前是第几步、这一步叫什么、做完怎么继续。弹出期间全屏压暗并
 * 挖孔锁定步骤条，观感与完整引导一致。挂在 StepIndicator 内部——
 * 18 个工具共用步骤条，一处接入全部生效。几秒后自动消失，也可手动
 * 关闭；总开关关闭时不弹。
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
  const [anchorRect, setAnchorRect] = useState<Rect | null>(null);
  const [pauseDismiss, setPauseDismiss] = useState(false);
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
    if (!hint || pauseDismiss) return;
    const timer = window.setTimeout(() => setHint(null), autoDismissMs);
    return () => window.clearTimeout(timer);
  }, [hint, autoDismissMs, pauseDismiss]);

  // 提示展示期间挖孔锁定步骤条：取第一个【可见】的步骤条（有后台任务
  // 的工具页会被 keep-alive 保活，同名挂点必须跳过），窗口缩放或滚动时
  // 跟着重量。量不到时没有挖孔，挡板自己整屏压暗兜底。
  useEffect(() => {
    if (!hint) {
      setAnchorRect(null);
      return;
    }
    const measure = () => {
      for (const el of document.querySelectorAll<HTMLElement>(
        '[data-tour="step-indicator"]',
      )) {
        if (!isVisibleIndicator(el)) continue;
        const r = el.getBoundingClientRect();
        setAnchorRect({
          top: r.top,
          left: r.left,
          width: r.width,
          height: r.height,
        });
        return;
      }
      setAnchorRect(null);
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [hint]);

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
    <Fragment key={hint.nonce}>
      {/* 全屏挡板：吃掉对页面的点击，点它等同点 ×，给用户一个更大的关闭
          热区。有挖孔时保持透明（压暗由聚光灯外圈承担），量不到步骤条时
          才自己整屏压暗兜底——否则背景全亮，看起来像坏了。 */}
      <div
        className={`step-hint-veil${anchorRect ? "" : " step-hint-veil-dimmed"}`}
        aria-hidden="true"
        onClick={() => setHint(null)}
      />
      {/* 聚光灯：挖孔锁定步骤条，观感与完整引导一致。 */}
      {anchorRect && (
        <div
          className="step-hint-spotlight"
          aria-hidden="true"
          style={{
            top: anchorRect.top - SPOTLIGHT_PAD,
            left: anchorRect.left - SPOTLIGHT_PAD,
            width: anchorRect.width + SPOTLIGHT_PAD * 2,
            height: anchorRect.height + SPOTLIGHT_PAD * 2,
          }}
        />
      )}
      <div
        className="step-hint"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        onMouseEnter={() => setPauseDismiss(true)}
        onMouseLeave={() => setPauseDismiss(false)}
        onFocusCapture={() => setPauseDismiss(true)}
      >
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
    </Fragment>
  );
}
