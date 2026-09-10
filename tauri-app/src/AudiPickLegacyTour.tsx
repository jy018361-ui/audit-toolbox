import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import "./AudiPickLegacyTour.css";

export type AudiPickTourCloseReason = "complete" | "skip" | "target-missing";

export type AudiPickTourStep = {
  /** A stable selector belonging to the real control that should be highlighted. */
  selector: string;
  title: string;
  description: string;
};

export const AUDIPICK_LEGACY_TOUR_STEPS: readonly AudiPickTourStep[] = [
  {
    selector: "#nav-cfg",
    title: "\u7b2c\u4e00\u6b65\uff1a\u914d\u7f6e AI \u63a5\u53e3 \u{1f511}",
    description:
      "AudiPick \u4f9d\u8d56\u5927\u6a21\u578b\u8fdb\u884c\u667a\u80fd\u63d0\u53d6\u3002\u8bf7\u5148\u8fdb\u5165\u914d\u7f6e\u9875\u9762\uff0c\u586b\u5199\u60a8\u7684 API Key\u3002",
  },
  {
    selector: "#btn-new-proj",
    title: "\u7b2c\u4e8c\u6b65\uff1a\u65b0\u5efa\u5ba1\u8ba1\u9879\u76ee \u{1f4c1}",
    description:
      "\u914d\u7f6e\u5b8c\u6210\u540e\uff0c\u5728\u8fd9\u91cc\u521b\u5efa\u4e00\u4e2a\u65b0\u9879\u76ee\uff0c\u7528\u4e8e\u5f52\u6863\u548c\u7ba1\u7406\u60a8\u7684\u5408\u540c\u6587\u4ef6\u3002",
  },
  {
    selector: "#nav-dash",
    title: "\u7b2c\u4e09\u6b65\uff1a\u4e0a\u4f20\u4e0e\u63d0\u53d6 \u{1f916}",
    description:
      "\u8fdb\u5165\u9879\u76ee\u540e\uff0c\u62d6\u62fd\u4e0a\u4f20 PDF \u5408\u540c\uff0c\u7cfb\u7edf\u4f1a\u81ea\u52a8\u8fdb\u884c OCR \u8bc6\u522b\u548c AI \u6761\u6b3e\u63d0\u53d6\uff0c\u6700\u540e\u53ef\u4e00\u952e\u5bfc\u51fa Excel \u5e95\u7a3f\uff01",
  },
];

export type AudiPickLegacyTourProps = {
  open: boolean;
  /** Pass this to control the active step from the parent. */
  currentStep?: number;
  /** Used when `currentStep` is not controlled. */
  defaultCurrentStep?: number;
  steps?: readonly AudiPickTourStep[];
  highlightPadding?: number;
  /** Mirrors 1.4.6's delayed lookup while the dashboard finishes rendering. */
  targetLookupDelayMs?: number;
  onCurrentStepChange?: (step: number) => void;
  onComplete?: () => void;
  onSkip?: () => void;
  onRequestClose?: (reason: AudiPickTourCloseReason) => void;
};

type Rect = {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

type TooltipPosition = {
  top: number;
  left: number;
  side: "right" | "bottom" | "left" | "top";
};

const TOOLTIP_WIDTH = 320;
const TOOLTIP_GAP = 20;
const VIEWPORT_MARGIN = 16;

function clampStep(step: number, stepCount: number) {
  return Math.min(Math.max(0, step), Math.max(0, stepCount - 1));
}

function elementRect(element: Element, padding: number): Rect {
  const rect = element.getBoundingClientRect();
  return {
    top: rect.top - padding,
    left: rect.left - padding,
    right: rect.right + padding,
    bottom: rect.bottom + padding,
    width: rect.width + padding * 2,
    height: rect.height + padding * 2,
  };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function placeTooltip(
  rect: Rect,
  tooltip: HTMLElement | null,
): TooltipPosition {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const tooltipWidth = tooltip?.offsetWidth || TOOLTIP_WIDTH;
  const tooltipHeight = tooltip?.offsetHeight || 188;

  let side: TooltipPosition["side"] = "right";
  let top = rect.top;
  let left = rect.right + TOOLTIP_GAP;

  if (left + tooltipWidth > viewportWidth - VIEWPORT_MARGIN) {
    side = "bottom";
    top = rect.bottom + TOOLTIP_GAP;
    left = rect.left;

    if (top + tooltipHeight > viewportHeight - VIEWPORT_MARGIN) {
      if (rect.left - TOOLTIP_GAP - tooltipWidth >= VIEWPORT_MARGIN) {
        side = "left";
        top = rect.top;
        left = rect.left - TOOLTIP_GAP - tooltipWidth;
      } else {
        side = "top";
        top = rect.top - TOOLTIP_GAP - tooltipHeight;
        left = rect.left;
      }
    }
  }

  return {
    side,
    top: clamp(
      top,
      VIEWPORT_MARGIN,
      viewportHeight - tooltipHeight - VIEWPORT_MARGIN,
    ),
    left: clamp(
      left,
      VIEWPORT_MARGIN,
      viewportWidth - tooltipWidth - VIEWPORT_MARGIN,
    ),
  };
}

/**
 * The guided-tour overlay from AudiPick portable 1.4.6, implemented against real
 * DOM targets. Persistence intentionally stays in the parent (`onComplete` /
 * `onSkip`) so the toolbox storage layer remains authoritative.
 */
export function AudiPickLegacyTour({
  open,
  currentStep,
  defaultCurrentStep = 0,
  steps = AUDIPICK_LEGACY_TOUR_STEPS,
  highlightPadding = 4,
  targetLookupDelayMs = 500,
  onCurrentStepChange,
  onComplete,
  onSkip,
  onRequestClose,
}: AudiPickLegacyTourProps) {
  const [internalStep, setInternalStep] = useState(defaultCurrentStep);
  const [rect, setRect] = useState<Rect | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState<TooltipPosition>({
    top: VIEWPORT_MARGIN,
    left: VIEWPORT_MARGIN,
    side: "right",
  });
  const tooltipRef = useRef<HTMLDivElement>(null);
  const previouslyOpenRef = useRef(false);
  const missingTargetReportedRef = useRef(false);
  const isControlled = currentStep !== undefined;
  const activeIndex = clampStep(
    isControlled ? currentStep : internalStep,
    steps.length,
  );
  const activeStep = steps[activeIndex];

  const requestClose = useCallback(
    (reason: AudiPickTourCloseReason) => {
      if (reason === "complete") onComplete?.();
      if (reason === "skip") onSkip?.();
      onRequestClose?.(reason);
    },
    [onComplete, onRequestClose, onSkip],
  );

  useEffect(() => {
    if (open && !previouslyOpenRef.current && !isControlled) {
      setInternalStep(clampStep(defaultCurrentStep, steps.length));
    }
    previouslyOpenRef.current = open;
  }, [defaultCurrentStep, isControlled, open, steps.length]);

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestClose("skip");
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, requestClose]);

  useLayoutEffect(() => {
    if (!open || !activeStep) {
      setRect(null);
      return undefined;
    }

    let target: Element | null = null;
    let resizeObserver: ResizeObserver | undefined;
    let lookupTimer: number | undefined;
    missingTargetReportedRef.current = false;

    const measure = () => {
      target = document.querySelector(activeStep.selector);
      if (!target) {
        setRect(null);
        return false;
      }
      const nextRect = elementRect(target, highlightPadding);
      setRect(nextRect);
      setTooltipPosition(placeTooltip(nextRect, tooltipRef.current));
      return true;
    };

    const observeTarget = () => {
      if (!target || typeof ResizeObserver === "undefined") return;
      resizeObserver?.disconnect();
      resizeObserver = new ResizeObserver(measure);
      resizeObserver.observe(target);
    };

    const measureAfterRender = () => {
      if (measure()) {
        observeTarget();
        return;
      }
      if (!missingTargetReportedRef.current) {
        missingTargetReportedRef.current = true;
        requestClose("target-missing");
      }
    };

    // Measure immediately when possible, then repeat after the same 500 ms
    // rendering allowance used by the portable 1.4.6 implementation.
    if (measure()) observeTarget();
    lookupTimer = window.setTimeout(measureAfterRender, targetLookupDelayMs);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);

    return () => {
      if (lookupTimer !== undefined) window.clearTimeout(lookupTimer);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [activeStep, highlightPadding, open, requestClose, targetLookupDelayMs]);

  const next = () => {
    if (activeIndex >= steps.length - 1) {
      requestClose("complete");
      return;
    }
    const nextStep = activeIndex + 1;
    if (!isControlled) setInternalStep(nextStep);
    onCurrentStepChange?.(nextStep);
  };

  if (!open || !activeStep || typeof document === "undefined") return null;

  const isLast = activeIndex === steps.length - 1;

  return createPortal(
    <div className="ap-legacy-tour" aria-live="polite">
      {rect ? (
        <div
          className="ap-legacy-tour__spotlight"
          aria-hidden="true"
          style={{
            top: `${rect.top}px`,
            left: `${rect.left}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`,
          }}
        />
      ) : (
        <div className="ap-legacy-tour__curtain" aria-hidden="true" />
      )}

      <div
        ref={tooltipRef}
        className="ap-legacy-tour__tooltip"
        data-side={tooltipPosition.side}
        role="dialog"
        aria-modal="true"
        aria-label={activeStep.title}
        style={{
          top: `${tooltipPosition.top}px`,
          left: `${tooltipPosition.left}px`,
          visibility: rect ? "visible" : "hidden",
        }}
      >
        <h3>{activeStep.title}</h3>
        <p>{activeStep.description}</p>
        <div className="ap-legacy-tour__footer">
          <span className="ap-legacy-tour__count">
            {activeIndex + 1} / {steps.length}
          </span>
          <div className="ap-legacy-tour__actions">
            <button
              type="button"
              className="ap-legacy-tour__skip"
              onClick={() => requestClose("skip")}
            >
              {"\u8df3\u8fc7"}
            </button>
            <button
              type="button"
              className="ap-legacy-tour__next"
              onClick={next}
            >
              {isLast
                ? "\u5b8c\u6210\u4f53\u9a8c"
                : "\u4e0b\u4e00\u6b65"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default AudiPickLegacyTour;
