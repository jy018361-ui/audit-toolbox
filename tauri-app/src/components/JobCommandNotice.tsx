import { useEffect, useState } from "react";
import { jobCancel } from "@/api";
import { errorText } from "@/lib/errors";
import { Button } from "@/components/ui/button";

const EVENT_NAME = "audit-toolbox:job-command-error";
const inFlight = new Set<string>();

/** 独立按钮没有内联进度组件时，统一兜住取消失败并避免重复指令。 */
export async function cancelJobWithFeedback(jobId: string): Promise<boolean> {
  if (inFlight.has(jobId)) return false;
  inFlight.add(jobId);
  try {
    const accepted = await jobCancel(jobId);
    if (!accepted) throw new Error("任务可能已结束，取消指令未被接受。请检查任务状态后重试。");
    return true;
  } catch (error) {
    window.dispatchEvent(new CustomEvent<string>(EVENT_NAME, {
      detail: `取消失败：${errorText(error)}`,
    }));
    return false;
  } finally {
    inFlight.delete(jobId);
  }
}

export function JobCommandNotice() {
  const [message, setMessage] = useState("");
  useEffect(() => {
    const show = (event: Event) => setMessage((event as CustomEvent<string>).detail);
    window.addEventListener(EVENT_NAME, show);
    return () => window.removeEventListener(EVENT_NAME, show);
  }, []);
  if (!message) return null;
  return (
    <div className="job-command-notice" role="alert">
      <span>{message}</span>
      <Button type="button" variant="ghost" size="sm" onClick={() => setMessage("")}>关闭</Button>
    </div>
  );
}
