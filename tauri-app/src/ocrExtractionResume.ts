import { ocrCall } from "./ocrApi";

export type OcrVerifiedResponse = { parsed: { coverage_complete: true; items: Record<string, unknown>[]; columns?: { key: string; label: string }[] } };
export interface OcrExtractionCache {
  contextKey: string;
  get(key: string): Promise<OcrVerifiedResponse | null>;
  put(key: string, entry: OcrVerifiedResponse): Promise<boolean>;
}
export type OcrExtractionDiagnostic = {
  sequence: number; attempt: number; status: "cached" | "validated" | "rejected" | "transport_error";
  elapsedMs: number; promptChars: number; sourceChars: number;
  reason?: "coverage" | "evidence" | "columns" | "facts" | "format" | "transport";
};

/** Stable hashes include the actual maintained/user prompts and case library;
 * native context additionally binds source revisions and unified LLM options. */
export async function ocrExtractionKey(value: unknown): Promise<string> {
  function canonical(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)]));
    return item;
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical(value))));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function openOcrExtractionCache(documentId: string): Promise<OcrExtractionCache> {
  const { contextKey } = await ocrCall<{ contextKey: string }>("ocr.extraction_context", { documentId });
  return {
    contextKey,
    get: async key => (await ocrCall<{ entry: OcrVerifiedResponse | null }>("ocr.extraction_cache_get", { documentId, contextKey, key })).entry,
    put: async (key, entry) => (await ocrCall<{ saved: boolean }>("ocr.extraction_cache_put", { documentId, contextKey, key, entry })).saved,
  };
}

export function extractionFailureReason(message: string): OcrExtractionDiagnostic["reason"] {
  if (/未确认本段检查完整|被截断|未检查完整/.test(message)) return "coverage";
  if (/列.*字段|表格列/.test(message)) return "columns";
  if (/目标字段|事实|未受.*支持|本金|期限/.test(message)) return "facts";
  if (/证据|行号|来源校验|漏掉.*义务|遗漏/.test(message)) return "evidence";
  return "format";
}
