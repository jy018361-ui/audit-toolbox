import { useEffect, useState } from "react";
import { z } from "zod";
import { jobCancel, jobStart, listenJobEvents } from "./api";
import type { JobEvent } from "./types";
import { errorText } from "./lib/errors";

export const LoanInspectionSchema = z.object({
  headers: z.array(z.string()), preview: z.array(z.array(z.string())),
  rowCount: z.number().int().nonnegative(), sheet: z.string(), sheets: z.array(z.string()),
  headerRow: z.number().int().positive(), headerDepth: z.number().int().positive(),
  suggestedMapping: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  sampledPreview: z.boolean().optional(), metadataComplete: z.boolean().optional(),
  entities: z.array(z.string()).optional(),
  entityAccounts: z.array(z.object({ entity: z.string(), account: z.string() })).optional(),
  dataYears: z.array(z.union([z.number().int(), z.string()])).optional(),
  suggestedBalanceSheetDate: z.string().nullable().optional(),
}).passthrough();

/** 先监听再启动，接住 worker 在 job_start 返回前发来的事件；换来源后取消本轮。 */
export function useLoanInspectionCompletion(
  key: string,
  params: Record<string, unknown>,
  onComplete: (value: z.infer<typeof LoanInspectionSchema>) => void,
) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ key: string; event?: JobEvent; error?: string }>({ key: "" });
  useEffect(() => {
    if (!key) return;
    let active = true, terminal = false, id = "";
    let unlisten: (() => void) | undefined;
    const early: JobEvent[] = [];
    setState({ key });
    const receive = (event: JobEvent) => {
      if (!active || terminal) return;
      if (!id) { early.push(event); if (early.length > 128) early.shift(); return; }
      if (event.jobId !== id) return;
      setState({ key, event });
      if (event.phase === "completed") {
        terminal = true;
        try {
          const full = LoanInspectionSchema.parse(event.result);
          if (full.sampledPreview || full.metadataComplete !== true) throw new Error("完整账表信息尚未补齐。");
          onComplete(full);
        } catch (error) { setState({ key, event, error: errorText(error) }); }
      } else if (event.phase === "failed" || event.phase === "cancelled") {
        terminal = true;
        setState({ key, event, error: event.message || "完整读取未完成，请重试。" });
      }
    };
    void (async () => {
      try {
        unlisten = await listenJobEvents(receive);
        if (!active) { unlisten(); return; }
        id = await jobStart("loan.inspect_full", params);
        if (!active) { void jobCancel(id).catch(() => undefined); return; }
        early.forEach(receive);
      } catch (error) {
        terminal = true;
        if (active) setState({ key, error: errorText(error) });
      }
    })();
    return () => {
      active = false;
      unlisten?.();
      if (id && !terminal) void jobCancel(id).catch(() => undefined);
    };
    // params 与完成时的映射快照跟随来源键固定；编辑映射不重启读取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);
  return { ...(state.key === key ? state : { key }), retry: () => setAttempt((n) => n + 1) };
}
