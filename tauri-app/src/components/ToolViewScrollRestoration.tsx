import { useLayoutEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { markToolPageLive } from "../toolPageActivity";

type Position = { left: number; top: number };

/** The document scroller is shared, but each tool owns its reading position. */
export function ToolViewScrollRestoration() {
  const { pathname } = useLocation();
  const positions = useRef(new Map<string, Position>());

  useLayoutEffect(() => {
    const previous = window.history.scrollRestoration;
    window.history.scrollRestoration = "manual";
    return () => { window.history.scrollRestoration = previous; };
  }, []);

  useLayoutEffect(() => {
    const toolId = /^\/tools\/([^/]+)/.exec(pathname)?.[1];
    const target = toolId ? positions.current.get(pathname) : undefined;
    let pending = true;
    let observer: ResizeObserver | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      pending = false;
      observer?.disconnect();
      clearTimeout(timeout);
    };
    const restore = () => {
      if (!pending) return;
      window.scrollTo({ left: target?.left ?? 0, top: target?.top ?? 0, behavior: "instant" });
      if (Math.abs(window.scrollY - (target?.top ?? 0)) <= 1 &&
          Math.abs(window.scrollX - (target?.left ?? 0)) <= 1) finish();
    };
    const save = () => {
      if (!toolId || pending) return;
      const position = { left: window.scrollX, top: window.scrollY };
      positions.current.set(pathname, position);
      if (position.left || position.top) markToolPageLive(toolId);
    };
    // A lazy page may initially be shorter than its saved offset. Retry when
    // its content arrives, but immediately yield to intentional user scrolling.
    restore();
    if (pending && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(restore);
      observer.observe(document.getElementById("main-content") ?? document.body);
    }
    if (pending) timeout = setTimeout(finish, 3000);
    window.addEventListener("scroll", save, { passive: true });
    window.addEventListener("wheel", finish, { passive: true });
    window.addEventListener("touchstart", finish, { passive: true });
    window.addEventListener("pointerdown", finish, { passive: true });
    window.addEventListener("keydown", finish);
    return () => {
      // Do not read here: hiding the outgoing page can already have clamped
      // the document offset. The scroll listener saved it while still visible.
      finish();
      window.removeEventListener("scroll", save);
      window.removeEventListener("wheel", finish);
      window.removeEventListener("touchstart", finish);
      window.removeEventListener("pointerdown", finish);
      window.removeEventListener("keydown", finish);
    };
  }, [pathname]);

  return null;
}
