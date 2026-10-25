import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * 带渐隐提示的滚动区：WebView2 的覆盖式滚动条会自动隐藏，长内容在
 * 底缘被裁一半时用户看不出「还能滚」。底缘/右缘还有未滚到的内容时
 * 给外框挂渐隐（与 DataTable 的 data-more-* 同一交互语言）。
 */
export function ScrollFadeBox({
  maxHeight,
  className,
  children,
}: {
  /** 滚动区最大高度（CSS 值），如 "min(52dvh, 420px)"。 */
  maxHeight?: string;
  className?: string;
  children: ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [more, setMore] = useState(false);
  const update = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const beyond = el.scrollHeight - el.clientHeight - el.scrollTop > 4;
    setMore((current) => (current === beyond ? current : beyond));
  }, []);
  // 内容变化后重算（每次渲染轻量执行，状态不变时不触发重渲）。
  useLayoutEffect(update);
  return (
    <div className={cn("scroll-fade", more && "scroll-fade--more", className)}>
      <div
        ref={scrollRef}
        onScroll={update}
        className="scroll-fade-scroll"
        style={maxHeight ? { maxHeight } : undefined}
      >
        {children}
      </div>
    </div>
  );
}
