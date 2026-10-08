export type LlmReviewPresentation = {
  label: string;
  attention: boolean;
};

/**
 * LLM 复核的统一展示语义。“已自动调整”表示已经生效，
 * “建议待确认”表示尚未生效；数量由当前明细实时派生，
 * 撤销或采纳后不会残留上一刻的结论。
 */
export function llmReviewPresentation(input: {
  busy?: boolean;
  failed?: boolean;
  applied?: number;
  pending?: number;
  missing?: number;
  warnings?: number;
}): LlmReviewPresentation {
  if (input.busy) return { label: "LLM 复核中", attention: false };
  if (input.failed)
    return { label: "LLM 复核失败 · 已保留原映射", attention: true };

  const applied = input.applied ?? 0;
  const pending = input.pending ?? 0;
  const missing = input.missing ?? 0;
  const warnings = input.warnings ?? 0;
  const parts: string[] = [];
  if (applied) parts.push(`已自动调整 ${applied} 项`);
  if (pending) parts.push(`${pending} 项建议待确认`);
  if (missing) parts.push(`仍缺 ${missing} 项`);
  if (warnings) parts.push(`${warnings} 项映射需核对`);
  if (!parts.length) parts.push("无需调整");
  return {
    label: `已复核 · ${parts.join(" · ")}`,
    attention: pending > 0 || missing > 0 || warnings > 0,
  };
}
