import { jobStart, listenJobEvents } from "./api";
import type { JobEvent } from "./types";
import type { AudiPickOperationHandle } from "./audipickOperation";

function terminalError(event: JobEvent) {
  const error = new Error(
    event.message ||
      (event.phase === "failed" ? "合同条款提取失败。" : "合同条款提取已终止。"),
  );
  error.name = event.phase === "failed" ? "AudiPickExtractFailed" : "AudiPickExtractCancelled";
  return error;
}

/** Run one LLM extraction stage in the cancellable Rust worker. */
export async function runAudiPickExtractJob<T>(
  params: Record<string, unknown>,
  operation: AudiPickOperationHandle,
): Promise<T> {
  await operation.checkpoint();
  let jobId = "";
  const early: JobEvent[] = [];
  let settle: ((event: JobEvent) => void) | undefined;
  const result = new Promise<T>((resolve, reject) => {
    settle = (event) => {
      if (event.phase === "completed") {
        resolve(event.result as T);
      } else if (["failed", "cancelled", "canceled"].includes(event.phase)) {
        reject(terminalError(event));
      }
    };
  });
  const off = await listenJobEvents((event) => {
    if (event.toolId !== "audipick") return;
    if (!jobId) {
      early.push(event);
      return;
    }
    if (event.jobId !== jobId) return;
    operation.update(event.message, event.current, event.total);
    settle?.(event);
  });
  try {
    jobId = await jobStart("audipick.extract", params);
    operation.attachJob(jobId);
    early
      .filter((event) => event.jobId === jobId)
      .forEach((event) => {
        operation.update(event.message, event.current, event.total);
        settle?.(event);
      });
    return await result;
  } finally {
    if (jobId) operation.detachJob(jobId);
    off();
  }
}
