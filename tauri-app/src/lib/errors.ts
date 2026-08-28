import type { AppError } from "@/types";

/**
 * 统一的错误文案提取。合并了此前分散在 App.tsx / TsManagerParityPage /
 * KanzhangParityPage / ConfirmationProgressPage 的五个实现。
 *
 * 回退链：userMessage → message → detail → Error.message → 中文兜底。
 */
export function errorText(error: unknown): string {
  if (!error) return "操作失败，请检查输入后重试。";
  if (typeof error === "string") return error;

  const e = error as AppError & Error;
  if (e?.userMessage) return e.userMessage;
  if (e?.message) return e.message;
  if (e?.detail) return e.detail;
  return "操作失败，请检查输入后重试。";
}
