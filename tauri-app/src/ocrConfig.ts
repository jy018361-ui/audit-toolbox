export const BAILIAN_OCR_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
export const BAILIAN_OCR_MODEL = "qwen3.5-ocr";

/** 连接测试只发送这张合成图片，不读取用户文件。 */
export function createOcrTestImage() {
  const canvas = document.createElement("canvas");
  canvas.width = 480;
  canvas.height = 100;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建 OCR 测试图片。");
  context.fillStyle = "white";
  context.fillRect(0, 0, 480, 100);
  context.fillStyle = "black";
  context.font = "32px sans-serif";
  context.fillText("AudiPick OCR 12345", 20, 62);
  return canvas.toDataURL("image/png").split(",")[1];
}

export function ocrEngineLabel(engine?: string) {
  const labels: Record<string, string> = { ai: "AI视觉", baidu: "百度OCR", local: "本机OCR", bailian: "百炼OCR" };
  return labels[engine ?? "ai"] ?? "未知OCR引擎";
}
