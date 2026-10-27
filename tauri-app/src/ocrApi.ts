import { engineCall, jobStart, listenJobEvents } from "./api";
import { ocrResponseSchemas } from "./ocrTypes";
import { errorText } from "./lib/errors";
import type { JobEvent } from "./types";

function parseOcrResponse<T>(method: string, value: unknown): T {
  const schema = ocrResponseSchemas[method];
  if (!schema) throw new Error("未找到对应的 OCR 接口。");
  const result = schema.safeParse(value);
  if (!result.success) throw new Error("OCR 返回的数据格式不完整，请重新读取或重试。");
  return result.data as T;
}

export async function ocrCall<T>(method: string, params: Record<string, unknown>): Promise<T> {
  if (!ocrResponseSchemas[method]) throw new Error("未找到对应的 OCR 接口。");
  return parseOcrResponse<T>(method, await engineCall(method, params));
}

/** Subscribe before starting: a fast worker can finish before invoke returns its id. */
export async function runOcrJob<T>(
  method: string, params: Record<string, unknown>,
  onJob?: (id: string) => void, onEvent?: (event: JobEvent) => void,
): Promise<T> {
  if (!["ocr.recognize_page", "ocr.extract", "ocr.export"].includes(method)) throw new Error("未找到对应的 OCR 任务。");
  let jobId: string | undefined;
  const early: JobEvent[] = [];
  let settle: (event: JobEvent) => void = () => {};
  const off = await listenJobEvents((event) => {
    if (event.toolId !== "ocr") return;
    if (!jobId) early.push(event);
    else if (event.jobId === jobId) settle(event);
  });
  try {
    // Construct after job_start succeeds, so a start rejection cannot orphan a rejected promise.
    jobId = await jobStart(method, params);
    return await new Promise<T>((resolve, reject) => {
      settle = (event) => {
        onEvent?.(event);
        if (event.phase === "completed") {
          try { resolve(parseOcrResponse<T>(method, event.result)); } catch (error) { reject(error); }
        } else if (["failed", "cancelled", "canceled"].includes(event.phase)) {
          const error = (event.result as { error?: unknown } | undefined)?.error;
          reject(new Error(event.phase === "failed" ? (error ? errorText(error) : event.message) : "操作已取消，已完成的页面已保留。"));
        }
      };
      onJob?.(jobId!);
      early.filter((event) => event.jobId === jobId).forEach(settle);
    });
  } finally { off(); }
}
