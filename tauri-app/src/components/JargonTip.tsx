import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CircleHelp } from "lucide-react";
import "./jargon-tip.css";

export type JargonTipProps = {
  term: string;
  text: string;
  className?: string;
};

/** 行话提示使用 body portal + fixed 坐标，不会被卡片 overflow 裁掉。 */
export function JargonTip({ term, text, className }: JargonTipProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number }>();
  const triggerRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const tipId = useId();

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = triggerRef.current?.getBoundingClientRect();
      const bubble = bubbleRef.current?.getBoundingClientRect();
      if (!trigger || !bubble) return;
      const gap = 6;
      const edge = 8;
      const above = trigger.top - bubble.height - gap;
      const top = above >= edge
        ? above
        : Math.min(trigger.bottom + gap, window.innerHeight - bubble.height - edge);
      const left = Math.min(
        Math.max(trigger.left + trigger.width / 2 - bubble.width / 2, edge),
        Math.max(window.innerWidth - bubble.width - edge, edge),
      );
      setPosition({ top: Math.max(top, edge), left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, text]);

  return (
    <>
      {/* span 避免嵌在 label 中时抢走隐式控件；补齐按钮语义和键盘操作。 */}
      <span
        ref={triggerRef}
        role="button"
        tabIndex={0}
        className={`jargon-tip-button${className ? ` ${className}` : ""}`}
        aria-label={`什么是${term}`}
        aria-describedby={open ? tipId : undefined}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            setOpen(false);
          }
        }}
      >
        <CircleHelp size={14} strokeWidth={2} aria-hidden="true" />
      </span>
      {open && createPortal(
        <span
          ref={bubbleRef}
          role="tooltip"
          id={tipId}
          className="jargon-tip-bubble"
          style={{
            top: position?.top ?? 0,
            left: position?.left ?? 0,
            visibility: position ? "visible" : "hidden",
          }}
        >
          {text}
        </span>,
        document.body,
      )}
    </>
  );
}
