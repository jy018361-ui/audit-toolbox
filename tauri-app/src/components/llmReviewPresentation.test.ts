import { describe, expect, it } from "vitest";
import { llmReviewPresentation } from "./llmReviewPresentation";

describe("LLM 复核展示语义", () => {
  it("区分已生效的自动调整与尚未生效的待确认建议", () => {
    expect(
      llmReviewPresentation({ applied: 2, pending: 1 }).label,
    ).toBe("已复核 · 已自动调整 2 项 · 1 项建议待确认");
  });

  it("撤销或采纳后只由当前数量派生结论", () => {
    expect(llmReviewPresentation({ applied: 0, pending: 1 }).label).toBe(
      "已复核 · 1 项建议待确认",
    );
    expect(llmReviewPresentation({ applied: 1, pending: 0 }).label).toBe(
      "已复核 · 已自动调整 1 项",
    );
    expect(llmReviewPresentation({}).label).toBe("已复核 · 无需调整");
  });

  it("模型没有提出修改但当前列全空时仍要求核对", () => {
    expect(llmReviewPresentation({ warnings: 1 })).toEqual({
      label: "已复核 · 1 项映射需核对",
      attention: true,
    });
  });
});
