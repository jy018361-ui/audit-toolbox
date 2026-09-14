/** LLM 映射复核低于此把握度时不进入界面，也不允许应用。 */
export const MIN_VISIBLE_LLM_REVIEW_CONFIDENCE = 0.6;

/**
 * 历史接口有少量未返回 confidence 的结果，继续沿用原行为；模型明确给出
 * 0～59% 时则视为没有可操作价值，直接丢弃。
 */
export const isVisibleLlmReviewConfidence = (confidence?: number): boolean =>
  confidence === undefined ||
  (Number.isFinite(confidence) &&
    confidence >= MIN_VISIBLE_LLM_REVIEW_CONFIDENCE);
