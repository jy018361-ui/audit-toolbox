import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";

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
 * The active page, two recent hidden pages, and pages with running jobs survive.
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

  return (
    <>
      {mountedToolIds.map((toolId) => {
        const active = toolId === activeToolId;
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
): string[] {
  const next = [...new Set(current)];
  if (activeToolId) {
    const previous = next.indexOf(activeToolId);
    if (previous >= 0) next.splice(previous, 1);
    next.push(activeToolId);
  }
  const limit = Math.max(0, maxHiddenPages) + (activeToolId ? 1 : 0);
  for (let index = 0; next.length > limit && index < next.length;) {
    const toolId = next[index];
    if (toolId === activeToolId || keepAlive.has(toolId)) {
      index += 1;
    } else {
      next.splice(index, 1);
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
