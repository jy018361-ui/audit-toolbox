import type { AppError } from "@/types";

/**
 * 统一的错误文案提取。合并了此前分散在 App.tsx / TsManagerParityPage /
 * KanzhangParityPage / ConfirmationProgressPage 的五个实现。
 *
 * 回退链：userMessage → message → detail → 中文兜底。
 * 校验类错误（MAPPING_INVALID 等）的 detail 是 validate_mapping 的完整结果
 * JSON，能拆开就拼在 userMessage 后面——否则界面只剩一句「校验未通过」，
 * 到底哪一条不通过要靠猜，而后端其实已经把原因写清楚了。
 */
export function errorText(error: unknown): string {
  if (!error) return "操作失败，请检查输入后重试。";
  if (typeof error === "string") return error;

  const e = error as AppError & Error;
  const detailed = validationDetail(e?.detail);
  if (e?.userMessage)
    return detailed ? `${e.userMessage}${detailed}` : e.userMessage;
  if (e?.message) return e.message;
  if (e?.detail) return e.detail;
  return "操作失败，请检查输入后重试。";
}

/** 校验未通过时，把后端塞在 detail 里的那段 `{errors:[...]}` JSON 拆成人话。 */
export function validationDetail(detail: unknown): string {
  if (typeof detail !== "string" || !detail.includes("errors")) return "";
  try {
    const parsed = JSON.parse(detail) as { errors?: unknown };
    const texts = ((parsed.errors ?? []) as unknown[]).filter(
      (x): x is string => typeof x === "string",
    );
    if (!texts.length) return "";
    return `具体是：${texts.map((text, index) => `${index + 1}. ${text}`).join("；")}`;
  } catch {
    return "";
  }
}
