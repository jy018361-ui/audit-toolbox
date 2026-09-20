import { describe, expect, it } from "vitest";
import { dedupeRepeatedText, textPreview } from "./presentationText";

describe("presentationText", () => {
  it("识别带错误前缀的重复句子", () => {
    const sentence = "无法读取工作簿；请关闭 Excel 后重试。";
    expect(dedupeRepeatedText(`处理失败：${sentence.repeat(4)}`)).toBe(
      "处理失败：无法读取工作簿；请关闭 Excel 后重试。\n（已合并 6 条重复信息）",
    );
  });

  it("长文本预览以省略号结束", () => {
    expect(textPreview("很长的错误说明".repeat(60), 80)).toMatch(/…$/u);
  });
});
