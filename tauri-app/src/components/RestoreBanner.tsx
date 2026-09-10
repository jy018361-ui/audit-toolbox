import { useEffect, useState } from "react";
import { subscribeTaskRestore } from "../restore";
import type { TaskRestore, ToolManifest } from "../types";

/**
 * 「继续任务」的全局结果提示。参数回填由各工具页自行完成，这里只负责
 * 告诉用户发生了什么：恢复了哪个工具的输入、有没有原文件已不存在。
 * 新的恢复会顶替旧提示，15 秒后自动消失。
 */
export function RestoreBanner({ catalog }: { catalog: ToolManifest[] }) {
  const [notice, setNotice] = useState<TaskRestore | null>(null);
  useEffect(
    () => subscribeTaskRestore((restore) => setNotice(restore)),
    [],
  );
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 15_000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  if (!notice) return null;
  const toolName =
    catalog.find((tool) => tool.id === notice.toolId)?.name ?? "对应工具";
  const missing = notice.missingPaths;
  return (
    <div className="restore-notice" role="status" aria-live="polite">
      <div>
        <strong>已恢复「{toolName}」上次任务的输入。</strong>
        <p>
          {missing.length > 0
            ? `有 ${missing.length} 个原文件已不存在（如 ${missing[0]}），请重新选择后再运行。`
            : "文件内容如有变动，请在页面中重新读取后再运行。"}
        </p>
      </div>
      <button type="button" onClick={() => setNotice(null)}>
        知道了
      </button>
    </div>
  );
}
