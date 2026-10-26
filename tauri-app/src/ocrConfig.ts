export const BAILIAN_OCR_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
export const BAILIAN_OCR_MODEL = "qwen3.5-ocr";

export function ocrEngineLabel(engine?: string) {
  const labels: Record<string, string> = { ai: "AI视觉", baidu: "百度OCR", local: "本机OCR", bailian: "百炼OCR" };
  return labels[engine ?? "ai"] ?? "未知OCR引擎";
}
