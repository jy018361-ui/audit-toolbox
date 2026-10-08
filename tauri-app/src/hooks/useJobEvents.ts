import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { listenJobEvents } from "@/api";
import type { JobEvent } from "@/types";

type UseJobEventsOptions = {
  toolId?: string;
  onEvent?: (event: JobEvent) => void;
};

const TERMINAL_PHASES = new Set(["completed", "failed", "cancelled", "done"]);

/**
 * A fast worker can emit its terminal event before `jobStart()` resolves. In that
 * case the page's synthetic queued state must not overwrite the real result.
 */
export function reconcileJobState(
  current: JobEvent | undefined,
  incoming: JobEvent | undefined,
): JobEvent | undefined {
  if (
    incoming?.phase === "queued" &&
    current?.jobId === incoming.jobId &&
    current.phase !== "queued"
  ) {
    return current;
  }
  return incoming;
}

/**
 * 统一的 job-event 监听 hook。
 *
 * 对比各页面前置实现的关键改进：同时记录当前激活的 jobId，事件到达时
 * 既匹配 toolId 也匹配 activeJobId——避免只按 toolId 过滤时，用户从
 * 其他页面启动的另一个同名任务的事件串进当前页面（竞态隐患）。
 */
export function useJobEvents({
  toolId,
  onEvent,
}: UseJobEventsOptions = {}) {
  const [job, setJobState] = useState<JobEvent | undefined>(undefined);
  const activeJobId = useRef<string | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const setJob = useCallback<Dispatch<SetStateAction<JobEvent | undefined>>>(
    (next) => {
      setJobState((current) => {
        const incoming =
          typeof next === "function" ? next(current) : next;
        const resolved = reconcileJobState(current, incoming);
        activeJobId.current =
          resolved && !TERMINAL_PHASES.has(resolved.phase)
            ? resolved.jobId
            : null;
        return resolved;
      });
    },
    [],
  );

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenJobEvents((event) => {
      // 只关心本工具的事件
      if (toolId && event.toolId !== toolId) return;
      // 若当前有激活任务，事件必须来自该任务，避免串台
      if (activeJobId.current && event.jobId !== activeJobId.current) return;
      // 首个事件到来时记为激活任务；任务完成/取消后清空
      if (!activeJobId.current && !TERMINAL_PHASES.has(event.phase)) {
        activeJobId.current = event.jobId;
      }
      if (TERMINAL_PHASES.has(event.phase)) {
        activeJobId.current = null;
      }
      if (disposed) return;
      setJob(event);
      onEventRef.current?.(event);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [toolId]);

  return { job, setJob, activeJobId };
}
