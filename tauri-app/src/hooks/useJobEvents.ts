import { useEffect, useRef, useState } from "react";
import { listenJobEvents } from "@/api";
import type { JobEvent } from "@/types";

type UseJobEventsOptions = {
  toolId?: string;
  onEvent?: (event: JobEvent) => void;
};

/**
 * 统一的 job-event 监听 hook。
 *
 * 对比各页面前置实现的关键改进：同时记录当前激活的 jobId，事件到达时
 * 既匹配 toolId 也匹配 activeJobId——避免只按 toolId 过滤时，用户从
 * 任务中心启动的另一个同名任务的事件串进当前页面（竞态隐患）。
 */
export function useJobEvents({
  toolId,
  onEvent,
}: UseJobEventsOptions = {}) {
  const [job, setJob] = useState<JobEvent | undefined>(undefined);
  const activeJobId = useRef<string | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenJobEvents((event) => {
      // 只关心本工具的事件
      if (toolId && event.toolId !== toolId) return;
      // 若当前有激活任务，事件必须来自该任务，避免串台
      if (activeJobId.current && event.jobId !== activeJobId.current) return;
      // 首个事件到来时记为激活任务；任务完成/取消后清空
      if (!activeJobId.current && event.phase !== "done") {
        activeJobId.current = event.jobId;
      }
      if (event.severity === "success" || event.phase === "done") {
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
