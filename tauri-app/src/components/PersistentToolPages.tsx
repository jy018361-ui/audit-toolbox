import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { telemetryTrack } from "../api";
import { liveToolPageIds, markToolPageLive } from "../toolPageActivity";

export function toolIdFromPathname(pathname: string): string | undefined {
  const match = /^\/tools\/([^/]+)\/?$/.exec(pathname);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

type PersistentToolPagesProps = {
  renderPage: (toolId: string) => ReactNode;
  /** Running jobs remain mounted even when the normal hidden-page cap is hit. */
  keepAliveToolIds?: string[];
  maxHiddenPages?: number;
};

/**
 * Keeps a small LRU set of visited tools mounted.
 *
 * Tool pages own sizeable upload, mapping and job state. Replacing the child of
 * `/tools/:toolId` immediately destroyed that state. Retaining every page,
 * however, accumulated large tables and listeners for the whole app lifetime.
 * Pages the user has actually worked in (see toolPageActivity) never evict —
 * they stay mounted until the app exits; only never-touched blank pages are
 * capped by `maxHiddenPages`, plus pages with running jobs.
 */
export function PersistentToolPages({
  renderPage,
  keepAliveToolIds = [],
  maxHiddenPages = 2,
}: PersistentToolPagesProps) {
  const { pathname } = useLocation();
  const activeToolId = toolIdFromPathname(pathname);
  const [visitedToolIds, setVisitedToolIds] = useState<string[]>([]);
  const wrappers = useRef(new Map<string, HTMLDivElement>());
  const keepAliveKey = [...new Set(keepAliveToolIds)].sort().join("\0");
  const keepAlive = useMemo(
    () => new Set(keepAliveKey ? keepAliveKey.split("\0") : []),
    [keepAliveKey],
  );

  useEffect(() => {
    setVisitedToolIds((current) => {
      const next = retainedToolIds(
        current,
        activeToolId,
        keepAlive,
        maxHiddenPages,
        liveToolPageIds(),
      );
      return arraysEqual(current, next) ? current : next;
    });
  }, [activeToolId, keepAlive, maxHiddenPages]);

  const mountedToolIds = useMemo(() => {
    return retainedToolIds(
      visitedToolIds,
      activeToolId,
      keepAlive,
      maxHiddenPages,
      liveToolPageIds(),
    );
  }, [activeToolId, keepAlive, maxHiddenPages, visitedToolIds]);

  useEffect(() => {
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement)) return;
    for (const [toolId, wrapper] of wrappers.current) {
      if (toolId !== activeToolId && wrapper.contains(focused)) {
        focused.blur();
        break;
      }
    }
  }, [activeToolId]);

  useEffect(() => {
    // 使用统计：切到某个工具页时记一条「打开工具」；
    // 工具名由 Rust 端按内嵌工具目录补齐，失败也不影响导航。
    if (activeToolId) void telemetryTrack("tool_open", activeToolId);
  }, [activeToolId]);

  return (
    <>
      {mountedToolIds.map((toolId) => {
        const active = toolId === activeToolId;
        // 「有现场」信号：用户在本页点击、输入或拖入文件即登记；登记后
        // 该页退出 LRU 淘汰，保活到应用退出（见 toolPageActivity.ts）。
        // 隐藏页带 inert，不会误发事件；active 页任何交互都算现场。
        return (
          <div
            key={toolId}
            ref={(node) => {
              if (node) wrappers.current.set(toolId, node);
              else wrappers.current.delete(toolId);
            }}
            className="persistent-tool-page"
            data-tool-page={toolId}
            hidden={!active}
            aria-hidden={active ? undefined : true}
            inert={!active}
            onClick={() => markToolPageLive(toolId)}
            onChange={() => markToolPageLive(toolId)}
            onDragEnter={() => markToolPageLive(toolId)}
          >
            {renderPage(toolId)}
          </div>
        );
      })}
    </>
  );
}

export function retainedToolIds(
  current: string[],
  activeToolId: string | undefined,
  keepAlive: ReadonlySet<string>,
  maxHiddenPages: number,
  liveToolPages: ReadonlySet<string> = new Set(),
): string[] {
  const next = [...new Set(current)];
  if (activeToolId) {
    const previous = next.indexOf(activeToolId);
    if (previous >= 0) next.splice(previous, 1);
    next.push(activeToolId);
  }
  // 受保护页（当前页 / 运行中任务 / 有现场）不淘汰、也不占名额；
  // `maxHiddenPages` 只约束从未动过的空白页。
  const isProtected = (toolId: string) =>
    toolId === activeToolId ||
    keepAlive.has(toolId) ||
    liveToolPages.has(toolId);
  let blankPages = next.filter((toolId) => !isProtected(toolId)).length;
  const limit = Math.max(0, maxHiddenPages);
  for (let index = 0; index < next.length && blankPages > limit;) {
    const toolId = next[index];
    if (isProtected(toolId)) {
      index += 1;
    } else {
      next.splice(index, 1);
      blankPages -= 1;
    }
  }
  return next;
}

function arraysEqual(left: string[], right: string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
