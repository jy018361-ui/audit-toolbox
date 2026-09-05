import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { PartyPopper, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import "./beginner-tour.css";

export type TourStep = {
  /** 稳定 id，作为步骤切换时重放入场动画的 key。 */
  id: string;
  title: string;
  body: ReactNode;
  /**
   * 目标元素选择器（推荐用 data-tour="..." 属性）。缺省表示居中卡片，
   * 用于欢迎 / 收尾这类不指向具体控件的步骤。
   */
  targetSelector?: string;
  /**
   * 目标找不到时直接跳过（例如"最近使用"为空时整块不渲染）。
   * 非 optional 的步骤找不到目标时退化为居中卡片，文案仍然可读。
   */
  optional?: boolean;
};

type Rect = { top: number; left: number; width: number; height: number; bottom: number };

type BubblePosition = {
  top: number;
  left: number;
  arrowOffset: number;
  placement: "bottom" | "top";
};

const EDGE_GAP = 16;
const TARGET_GAP = 14;
const SPOTLIGHT_PAD = 6;
const RETRY_INTERVAL_MS = 150;
/** 约 0.6 秒：等待目标只为覆盖翻步瞬间的一帧懒加载首绘；
 *  目标真不存在时（工具没有该区域）必须快点给结论，
 *  否则用户面对整屏压暗的空窗等 3 秒，像卡了 bug。 */
const RETRY_LIMIT = 4;
/** 兜底夹取的最小边距：气泡 / 聚光灯至少留 8px 在视口内，不整体跑到屏幕外。 */
const MIN_VIEWPORT_GAP = 8;

function isTargetVisible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  // keep-alive 隐藏页是 display:none，宽高为 0，据此排除。
  return rect.width >= 2 && rect.height >= 2;
}

/** 元素真的渲染出来了才可聚焦：祖先链上的 display:none / visibility:hidden
 *  都要排除，否则 Tab 会落进隐藏气泡里凭空消失。 */
function isRenderedFocusable(el: HTMLElement): boolean {
  if (typeof el.checkVisibility === "function") {
    return el.checkVisibility({ checkVisibilityCSS: true });
  }
  const style = getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden";
}

/** 取选择器下第一个【可见】的匹配。querySelector 只按 DOM 顺序取第一个，
 *  有后台任务的工具页会被 keep-alive 保活（display:none），同名挂点排在
 *  前面就会把当前页的目标"挡住"，引导永远找不到目标。 */
function findVisibleTarget(selector: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(selector)) {
    if (isTargetVisible(el)) return el;
  }
  return null;
}

function findStepTarget(step: TourStep): HTMLElement | null {
  if (!step.targetSelector) return null;
  const el = findVisibleTarget(step.targetSelector);
  return el;
}

/** 把目标矩形外扩一圈后夹回视口：目标特别高 / 宽时挖孔也不会整块跑出屏幕。 */
function clampSpotlightBox(rect: Rect): {
  top: number;
  left: number;
  width: number;
  height: number;
} {
  const top = Math.max(rect.top - SPOTLIGHT_PAD, MIN_VIEWPORT_GAP);
  const left = Math.max(rect.left - SPOTLIGHT_PAD, MIN_VIEWPORT_GAP);
  const bottom = Math.min(
    rect.bottom + SPOTLIGHT_PAD,
    window.innerHeight - MIN_VIEWPORT_GAP,
  );
  const right = Math.min(
    rect.left + rect.width + SPOTLIGHT_PAD,
    window.innerWidth - MIN_VIEWPORT_GAP,
  );
  return {
    top,
    left,
    width: Math.max(right - left, 0),
    height: Math.max(bottom - top, 0),
  };
}

/** 从 from 沿 dir 找第一个可展示的步骤；optional 且目标缺失的步骤被跳过。null 表示没有可展示步骤。 */
function findRenderableIndex(
  steps: TourStep[],
  from: number,
  dir: 1 | -1,
): number | null {
  let i = from;
  while (i >= 0 && i < steps.length) {
    const step = steps[i];
    if (!step.targetSelector || !step.optional || findStepTarget(step)) {
      return i;
    }
    i += dir;
  }
  return null;
}

/**
 * 新手引导引擎：全屏遮罩挖孔聚光灯 + 指向目标的动画气泡。
 * 只负责"怎么播"，播什么由调用方传入 steps；看过与否由调用方持久化。
 */
export function BeginnerTour({
  steps,
  onFinish,
  retryIntervalMs = RETRY_INTERVAL_MS,
  retryLimit = RETRY_LIMIT,
}: {
  steps: TourStep[];
  /** completed=true 表示用户走到最后一步完成，false 表示中途跳过。 */
  onFinish: (completed: boolean) => void;
  /** 测试可注入：目标元素轮询间隔与次数上限。 */
  retryIntervalMs?: number;
  retryLimit?: number;
}) {
  const [index, setIndex] = useState(
    () => findRenderableIndex(steps, 0, 1) ?? -1,
  );
  const [rect, setRect] = useState<Rect | null>(null);
  const [spotlightRadius, setSpotlightRadius] = useState(12);
  const [targetGaveUp, setTargetGaveUp] = useState(false);
  const [bubblePos, setBubblePos] = useState<BubblePosition | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const primaryButtonRef = useRef<HTMLButtonElement>(null);

  const currentStep = index >= 0 ? steps[index] : undefined;

  const go = (dir: 1 | -1) => {
    if (index < 0) return;
    const next = findRenderableIndex(steps, index + dir, dir);
    if (next === null) {
      // 往后走完即完成；往前越界视为取消（正常不会发生：首步隐藏上一步）。
      onFinish(dir > 0);
    } else {
      setIndex(next);
    }
  };

  // 一条可展示的步骤都没有：直接按完成处理，不留空遮罩。
  useEffect(() => {
    if (index < 0) onFinish(true);
  }, [index, onFinish]);

  // 定位当前步骤的目标元素。工具页懒加载时首轮可能查不到，轮询重试。
  // 用 layout effect：在绘帧前完成测量，翻步时不会闪现一帧旧位置。
  useLayoutEffect(() => {
    setTargetGaveUp(false);
    setRect(null);
    const selector = currentStep?.targetSelector;
    if (index < 0 || !selector) return;
    let cancelled = false;
    let timer = 0;
    let tries = 0;
    const apply = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height, bottom: r.bottom });
      const parsed = parseFloat(getComputedStyle(el).borderTopLeftRadius);
      setSpotlightRadius(
        Number.isFinite(parsed) ? Math.min(parsed + SPOTLIGHT_PAD, 24) : 12,
      );
    };
    // 目标尺寸正常但落在首屏之外（如工作台导览的工具卡片在页面下方）：
    // 引导期间锁了 body 滚动、挡板又吃掉滚轮，用户自己滚不过来，
    // 必须先把目标滚进视口再测量，否则聚光灯和气泡画到屏幕外，用户直接卡死。
    let scrolledToTarget = false;
    const attempt = () => {
      const el = findVisibleTarget(selector);
      if (el) {
        const r = el.getBoundingClientRect();
        const inViewport =
          r.top >= 0 &&
          r.left >= 0 &&
          r.bottom <= window.innerHeight &&
          r.right <= window.innerWidth;
        if (!inViewport && !scrolledToTarget) {
          // 只主动滚一次：目标比视口还高时滚完也量不到"完整可见"，
          // 反复滚只会原地打转，交给聚光灯 / 气泡的视口夹取兜底。
          scrolledToTarget = true;
          el.scrollIntoView({
            block: "center",
            inline: "nearest",
            behavior: "auto",
          });
          return false;
        }
        apply(el);
        return true;
      }
      return false;
    };
    if (!attempt()) {
      const retry = () => {
        if (cancelled) return;
        if (attempt()) return;
        tries += 1;
        if (tries >= retryLimit) {
          setTargetGaveUp(true);
          return;
        }
        timer = window.setTimeout(retry, retryIntervalMs);
      };
      timer = window.setTimeout(retry, retryIntervalMs);
    }
    // 窗口缩放或页面滚动时聚光灯跟着走；capture 捕获内部滚动容器。
    const remeasure = () => {
      const el = findVisibleTarget(selector);
      if (el) apply(el);
    };
    window.addEventListener("resize", remeasure);
    window.addEventListener("scroll", remeasure, true);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.removeEventListener("resize", remeasure);
      window.removeEventListener("scroll", remeasure, true);
    };
  }, [currentStep, index, retryIntervalMs, retryLimit]);

  // optional 步骤重试超时仍找不到目标：静默跳过，不打断引导节奏。
  useEffect(() => {
    if (!targetGaveUp || !currentStep?.optional) return;
    const next = findRenderableIndex(steps, index + 1, 1);
    if (next === null) onFinish(true);
    else setIndex(next);
  }, [targetGaveUp, currentStep, index, steps, onFinish]);

  // 气泡摆放：优先放目标下方，放不下放上方；水平方向夹在视口内，
  // 箭头对准目标中线（气泡被夹到边缘时箭头留在气泡范围内）。
  useLayoutEffect(() => {
    const bubble = bubbleRef.current;
    if (!rect || !bubble) {
      setBubblePos(null);
      return;
    }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const bw = bubble.offsetWidth;
    const bh = bubble.offsetHeight;
    const left = Math.min(
      Math.max(rect.left + rect.width / 2 - bw / 2, EDGE_GAP),
      Math.max(vw - bw - EDGE_GAP, EDGE_GAP),
    );
    const spaceBelow = vh - rect.bottom;
    const placement: BubblePosition["placement"] =
      spaceBelow >= bh + TARGET_GAP + EDGE_GAP || spaceBelow >= rect.top
        ? "bottom"
        : "top";
    const rawTop = placement === "bottom"
      ? rect.bottom + TARGET_GAP
      : rect.top - TARGET_GAP - bh;
    // 兜底：目标特别高时上下都放不下，算出的 top 会落到屏幕外，
    // 把气泡夹回视口内保证任何情况下提示都可见。
    const top = Math.min(
      Math.max(rawTop, MIN_VIEWPORT_GAP),
      Math.max(vh - bh - MIN_VIEWPORT_GAP, MIN_VIEWPORT_GAP),
    );
    const arrowOffset = Math.min(
      Math.max(rect.left + rect.width / 2 - left, 24),
      bw - 24,
    );
    setBubblePos({ top, left, arrowOffset, placement });
  }, [rect, index]);

  // 键盘操作：Esc 退出、←/→ 翻步；Tab / Shift+Tab 在引导层内循环；
  // 焦点在引导按钮上时 Enter 交给 click，否则会连翻两步。
  // 正在输入的控件不抢按键。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (
        event.key === "Enter" &&
        target?.closest(".tour-bubble, .tour-card")
      ) {
        return;
      }
      if (event.key === "Tab") {
        // 焦点圈定：引导是 aria-modal 对话框，Tab 不能跑到背景里去。
        // 不圈定的话焦点会落到背景中第一个可聚焦元素——左上角的
        //「跳过导航，进入工作区」链接，它一获得焦点就从屏幕顶滑入，
        // 看起来像凭空冒出来的"取消导航"提示。
        const layer = layerRef.current;
        if (!layer) return;
        const focusable = Array.from(
          layer.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), [tabindex="0"]',
          ),
        ).filter(isRenderedFocusable);
        if (focusable.length === 0) {
          // 等待定位时气泡整体隐藏，层内暂无可聚焦元素：不放 Tab 出去。
          event.preventDefault();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        if (!(active instanceof HTMLElement) || !layer.contains(active)) {
          event.preventDefault();
          first.focus();
          return;
        }
        if (event.shiftKey && active === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        onFinish(false);
      } else if (event.key === "ArrowRight") {
        go(1);
      } else if (event.key === "ArrowLeft") {
        go(-1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  // 引导期间锁住背景滚动；结束后把焦点还给打开引导前的位置。
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus?.();
    };
  }, []);

  // 每换一步把焦点移到主按钮，键盘用户不用重新找位置。
  useEffect(() => {
    primaryButtonRef.current?.focus();
  }, [index, bubblePos, targetGaveUp]);

  if (!currentStep) return null;
  const wantsTarget = Boolean(currentStep.targetSelector);
  // 有目标但还没量到位置（懒加载中）：气泡先挂载（隐藏）等定位，
  // 不能退回居中卡片，否则找到目标后会"先居中再飞过去"闪一下；
  // 只有重试超时确认目标不存在时才退化为居中卡片。
  const centered = !wantsTarget || (!rect && targetGaveUp);
  const isLast = index === steps.length - 1;
  const spotlightBox = rect ? clampSpotlightBox(rect) : null;

  const actions = (
    <div className="tour-actions">
      <Button variant="ghost" size="sm" onClick={() => onFinish(false)}>
        跳过引导
      </Button>
      <div className="tour-actions-nav">
        {index > 0 && (
          <Button variant="outline" size="sm" onClick={() => go(-1)}>
            上一步
          </Button>
        )}
        <Button ref={primaryButtonRef} size="sm" onClick={() => go(1)}>
          {isLast ? "完成" : "下一步"}
        </Button>
      </div>
    </div>
  );
  const dots = (
    <div className="tour-dots" aria-hidden="true">
      {steps.map((step, i) => (
        <span key={step.id} className={i === index ? "active" : undefined} />
      ))}
    </div>
  );
  const stepCount = `第 ${index + 1} 步 · 共 ${steps.length} 步`;

  return (
    <div
      ref={layerRef}
      className="tour-layer"
      role="dialog"
      aria-modal="true"
      aria-label={`新手引导：${currentStep.title}`}
    >
      {/* 透明挡板：吃掉对底层的所有点击。层级低于窗口控制按钮（800），
          引导期间最小化 / 关闭窗口仍然可用。没有挖孔目标时（居中卡片、
          等待定位）挡板自己整屏压暗，否则背景会全亮，看起来像坏了。 */}
      <div
        className={`tour-blocker${rect ? "" : " tour-blocker-dimmed"}`}
        aria-hidden="true"
      />
      {spotlightBox && (
        <>
          <div
            className="tour-spotlight"
            style={{
              top: spotlightBox.top,
              left: spotlightBox.left,
              width: spotlightBox.width,
              height: spotlightBox.height,
              borderRadius: spotlightRadius,
            }}
          />
          <div
            className="tour-pulse"
            style={{
              top: spotlightBox.top,
              left: spotlightBox.left,
              width: spotlightBox.width,
              height: spotlightBox.height,
              borderRadius: spotlightRadius,
            }}
            aria-hidden="true"
          />
        </>
      )}
      {centered ? (
        <div className="tour-card" key={currentStep.id}>
          <div className="tour-card-icon" aria-hidden="true">
            {isLast ? <PartyPopper size={26} /> : <Sparkles size={26} />}
          </div>
          <p className="tour-step-count">{stepCount}</p>
          <h2 className="tour-title">{currentStep.title}</h2>
          <div className="tour-body">{currentStep.body}</div>
          {actions}
          {dots}
        </div>
      ) : (
        <div
          ref={bubbleRef}
          key={currentStep.id}
          className={`tour-bubble placement-${bubblePos?.placement ?? "bottom"}`}
          style={{
            top: bubblePos?.top ?? 0,
            left: bubblePos?.left ?? 0,
            visibility: bubblePos ? "visible" : "hidden",
          }}
        >
          <div className="tour-bubble-inner">
            <span
              className="tour-bubble-arrow"
              style={{ left: bubblePos?.arrowOffset ?? 24 }}
              aria-hidden="true"
            />
            <p className="tour-step-count">{stepCount}</p>
            <h2 className="tour-title">{currentStep.title}</h2>
            <div className="tour-body">{currentStep.body}</div>
            {actions}
            {dots}
          </div>
        </div>
      )}
    </div>
  );
}
