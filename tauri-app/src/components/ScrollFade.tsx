import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
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

/**
 * 双轴滚动检测 hook：给「容器自身就是滚动区」的自定义表格用（如
 * loan-account-confirm）。ref 只挂内层滚动区，data-more-* 只展开到
 * 不滚动的外框；CSS 在外框绘制渐隐，不能把提示层与 ref 挂到同一个元素。
 */
export function useScrollFadeFlags<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [flags, setFlags] = useState<{ right: boolean; bottom: boolean }>({ right: false, bottom: false });
  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const right = el.scrollWidth - el.clientWidth - el.scrollLeft > 4;
    const bottom = el.scrollHeight - el.clientHeight - el.scrollTop > 4;
    setFlags((current) => (current.right === right && current.bottom === bottom ? current : { right, bottom }));
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    update();
    el.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(update);
      observer.observe(el);
    }
    return () => {
      el.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      observer?.disconnect();
    };
  }, [update]);
  return {
    ref,
    ...(flags.right ? { "data-more-right": "true" as const } : {}),
    ...(flags.bottom ? { "data-more-bottom": "true" as const } : {}),
  };
}
