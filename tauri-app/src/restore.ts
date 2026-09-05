import { useEffect, useRef } from "react";
import type { TaskRestore } from "./types";

// —— 历史记录「继续任务」的参数回填通道 ——
// History 页 publish → 跳转对应工具页 → 页面（无论首次挂载还是保活复用）
// 消费并回填表单。不走 route state：工具页由 PersistentToolPages 保活，
// 二次进入不会重跑 useState 初始化；订阅 + 待取双通道才能两头都接住。

const listeners = new Set<(restore: TaskRestore) => void>();
let pending: TaskRestore | null = null;

/** 一个工具挂多个子界面时（fa_list 有清单对比 / 账表核对两种模式），
 * 按参数形状把恢复包路由到对应子页：页面订阅用这个更具体的 key。 */
function restoreKeyOf(toolId: string, params: Record<string, unknown>): string {
  if (toolId === "fa_list")
    return params.tbSource || params.jeSource
      ? "fa_list:tbje"
      : "fa_list:cards";
  return toolId;
}

/** 历史页点击「继续任务」后调用：暂存恢复包并广播（此时目标页可能未挂载）。 */
export function publishTaskRestore(restore: TaskRestore): void {
  pending = restore;
  for (const listener of [...listeners]) listener(restore);
}

/** 取走属于指定工具的待恢复包；不是本页的（或没有）返回 null。 */
export function consumeTaskRestore(toolId: string): TaskRestore | null {
  if (
    pending &&
    restoreKeyOf(pending.toolId, pending.params) === toolId
  ) {
    const restore = pending;
    pending = null;
    return restore;
  }
  return null;
}

export function subscribeTaskRestore(
  listener: (restore: TaskRestore) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 工具页接入历史参数回填。挂载时消费待取的恢复包；页面已保活时经订阅
 * 收到。恢复包 params 为空（旧版本任务）不会触发 apply。
 */
export function useTaskRestore(
  toolId: string,
  apply: (restore: TaskRestore) => void,
): void {
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useEffect(() => {
    const take = () => {
      const restore = consumeTaskRestore(toolId);
      if (restore && Object.keys(restore.params).length > 0)
        applyRef.current(restore);
    };
    const stop = subscribeTaskRestore(take);
    take();
    return stop;
  }, [toolId]);
}
