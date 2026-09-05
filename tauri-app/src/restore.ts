import { useEffect, useRef } from "react";
import type { TaskRestore } from "./types";

// —— 历史记录「继续任务」的参数回填通道 ——
// History 页 publish → 跳转对应工具页 → 页面（无论首次挂载还是保活复用）
// 消费并回填表单。不走 route state：工具页由 PersistentToolPages 保活，
// 二次进入不会重跑 useState 初始化；订阅 + 待取双通道才能两头都接住。

/**
 * 这些方法是工具内部的读取/筛选子步骤，存档里只有部分配置（如看账的
 * inspect 只有文件路径没有字段映射）——恢复它们等于把现场覆盖成半成品。
 * 历史页只对主任务方法显示「继续任务」。
 */
const RESTORE_BLOCKED_METHODS = new Set([
  "kanzhang.inspect",
  "kanzhang.filter",
  "kanzhang.mark_inspect",
  "ts.inspect",
  "ts.filter",
  "file_list.scan",
  "fuzzy.export",
  // 汇率拉取是测算的辅助步骤，存档里没有账表配置。
  "fx.fetch_rates",
]);

/** 历史行是否可恢复：有参数存档，且不是被排除的子步骤方法。 */
export function historyRowCanResume(row: {
  method?: string;
  params?: Record<string, unknown> | null;
}): boolean {
  if (!row.params || Object.keys(row.params).length === 0) return false;
  return !RESTORE_BLOCKED_METHODS.has(String(row.method ?? ""));
}

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
