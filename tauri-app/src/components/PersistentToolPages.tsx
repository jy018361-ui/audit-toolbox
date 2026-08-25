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
};

/**
 * Keeps every visited tool mounted for the lifetime of the app.
 *
 * Tool pages own sizeable upload, mapping and job state. Replacing the child of
 * `/tools/:toolId` destroyed that state and detached its job listeners. Hidden
 * pages use both `hidden` and `inert`: effects can keep following their running
 * jobs, while their DOM cannot receive focus, pointer or keyboard interaction.
 */
export function PersistentToolPages({ renderPage }: PersistentToolPagesProps) {
  const { pathname } = useLocation();
  const activeToolId = toolIdFromPathname(pathname);
  const [visitedToolIds, setVisitedToolIds] = useState<string[]>([]);
  const wrappers = useRef(new Map<string, HTMLDivElement>());

  useEffect(() => {
    if (!activeToolId) return;
    setVisitedToolIds((current) =>
      current.includes(activeToolId) ? current : [...current, activeToolId],
    );
  }, [activeToolId]);

  const mountedToolIds = useMemo(() => {
    if (!activeToolId || visitedToolIds.includes(activeToolId))
      return visitedToolIds;
    // Render a directly opened tool immediately; the effect above then commits
    // it to the persistent list for subsequent route changes.
    return [...visitedToolIds, activeToolId];
  }, [activeToolId, visitedToolIds]);

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
