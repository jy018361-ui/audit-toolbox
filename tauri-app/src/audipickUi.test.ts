import { describe, expect, it } from "vitest";
import {
  buildRevenueBatchPrompt,
  buildRevenueQuestionBatches,
  mergeRevenueAnswers,
  buildClassifyPrompt,
  classifySample,
  extractionCacheKey,
  matchEvidenceDocument,
  pickClassifiedRule,
  splitContractText,
  withRetry,
} from "./audipickUi";

const page = (index: number, body: string) => `---PDF第${index}页---\n${body}\n`;

describe("splitContractText", () => {
  it("keeps a short contract in a single request", () => {
    const text = page(1, "甲方与乙方订立本合同。");
    expect(splitContractText(text)).toEqual([text]);
  });

  it("covers the whole contract when it has to split", () => {
    const text = Array.from({ length: 40 }, (_, index) =>
      page(index + 1, "条款".repeat(200)),
    ).join("");
    const chunks = splitContractText(text);
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk except the first carries a repeated page marker, so compare
    // against the source with those markers stripped back out.
    const rejoined = chunks
      .map((chunk, index) => (index === 0 ? chunk : chunk.replace(/^---PDF第\d+页---\n/, "")))
      .join("");
    expect(rejoined).toBe(text);
  });

  it("labels every later chunk with the page it starts inside", () => {
    const text = Array.from({ length: 40 }, (_, index) =>
      page(index + 1, "条款".repeat(200)),
    ).join("");
    const chunks = splitContractText(text);
    for (const chunk of chunks.slice(1)) {
      expect(chunk).toMatch(/^---PDF第\d+页---/);
    }
  });

  it("does not exceed the single-request limit per chunk by more than a marker", () => {
    const text = "合同条款".repeat(20_000);
    for (const chunk of splitContractText(text)) {
      expect(chunk.length).toBeLessThanOrEqual(8_100);
    }
  });
});

describe("document classification", () => {
  const rules = [
    { id: "loan_covenant", name: "借款·限制性契约", docKind: "clause" },
    { id: "invoice", name: "发票", docKind: "table" },
  ];

  it("lists every selectable template in the prompt", () => {
    const prompt = buildClassifyPrompt(rules);
    expect(prompt).toContain("loan_covenant | 借款·限制性契约 | 条款");
    expect(prompt).toContain("invoice | 发票 | 表格");
  });

  it("truncates the sample it sends", () => {
    const sample = classifySample("合同.pdf", "条".repeat(20_000));
    expect(sample).toContain("合同.pdf");
    expect(sample.length).toBeLessThan(12_200);
  });

  it("accepts a recommendation that names a real template", () => {
    const picked = pickClassifiedRule(
      { rule_id: "invoice", doc_label: "增值税发票", confidence: "高", reason: "含税额栏" },
      ["loan_covenant", "invoice"],
      "loan_covenant",
    );
    expect(picked).toMatchObject({
      ruleId: "invoice",
      docLabel: "增值税发票",
      confidence: "high",
    });
  });

  it("keeps the current template when the model invents one", () => {
    const picked = pickClassifiedRule(
      { rule_id: "not_a_rule", confidence: "high" },
      ["loan_covenant", "invoice"],
      "loan_covenant",
    );
    expect(picked.ruleId).toBe("loan_covenant");
    expect(picked.confidence).toBe("low");
    expect(picked.reason).toContain("不在可选列表");
  });
});

describe("matchEvidenceDocument", () => {
  const documents = [
    { id: "d1", name: "主合同.pdf" },
    { id: "d2", name: "主合同补充协议.pdf" },
  ];

  it("resolves the supplement rather than the contract it is named after", () => {
    expect(matchEvidenceDocument("主合同补充协议.pdf 第3页", documents)).toBe("d2");
  });

  it("matches on the stem when the citation drops the extension", () => {
    expect(matchEvidenceDocument("见主合同第 2 条", documents)).toBe("d1");
  });

  it("returns nothing when the citation names no known file", () => {
    expect(matchEvidenceDocument("对账单.pdf", documents)).toBeUndefined();
    expect(matchEvidenceDocument("", documents)).toBeUndefined();
  });
});

describe("extractionCacheKey", () => {
  it("is stable for identical requests", () => {
    expect(extractionCacheKey("d1", "invoice", "f1", "文本")).toBe(
      extractionCacheKey("d1", "invoice", "f1", "文本"),
    );
  });

  it("changes when the supporting documents change", () => {
    expect(extractionCacheKey("d1", "invoice", "f1", "文本")).not.toBe(
      extractionCacheKey("d1", "invoice", "f1", "文本\n附件"),
    );
  });
});

describe("withRetry", () => {
  const noSleep = async () => {};

  it("returns the first successful attempt", async () => {
    let calls = 0;
    const value = await withRetry(
      async () => {
        calls += 1;
        return "ok";
      },
      3,
      0,
      undefined,
      noSleep,
    );
    expect(value).toBe("ok");
    expect(calls).toBe(1);
  });

  it("recovers from a transient failure", async () => {
    let calls = 0;
    const remaining: number[] = [];
    const value = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("429");
        return "ok";
      },
      3,
      0,
      (left) => remaining.push(left),
      noSleep,
    );
    expect(value).toBe("ok");
    expect(calls).toBe(3);
    expect(remaining).toEqual([2, 1]);
  });

  it("gives up with the last error after exhausting attempts", async () => {
    await expect(
      withRetry(
        async () => {
          throw new Error("down");
        },
        2,
        0,
        undefined,
        noSleep,
      ),
    ).rejects.toThrow("down");
  });
});

describe("revenue workpaper two-pass flow", () => {
  const questions = Array.from({ length: 43 }, (_, index) => ({
    sheet: `第${Math.floor(index / 10) + 1}步`,
    row: index + 5,
    questionNo: `${index + 1}.1`,
    question: `问题${index + 1}`,
  }));

  it("splits all questions into batches without losing any", () => {
    const batches = buildRevenueQuestionBatches(questions);
    expect(batches.length).toBe(5);
    expect(batches.flat().map((item) => item.questionNo)).toEqual(
      questions.map((item) => item.questionNo),
    );
  });

  it("tells each batch exactly which questions and cells it owns", () => {
    const [batch] = buildRevenueQuestionBatches(questions);
    const prompt = buildRevenueBatchPrompt("底稿提示词", batch);
    expect(prompt).toContain("底稿提示词");
    expect(prompt).toContain("共 9 题");
    expect(prompt).toContain("题号 1.1（第1步 第 5 行）");
  });

  it("passes confirmed facts into the question prompt", () => {
    const [batch] = buildRevenueQuestionBatches(questions);
    const prompt = buildRevenueBatchPrompt("底稿提示词", batch, [
      {
        fact_type: "付款条件",
        fact_summary: "对账后 60 个自然日内付款",
        source_document: "主合同.pdf",
        pages: "【第3页】",
      },
    ]);
    expect(prompt).toContain("对账后 60 个自然日内付款");
    expect(prompt).toContain("主合同.pdf");
  });

  it("keeps the best-supported answer for a repeated question", () => {
    const merged = mergeRevenueAnswers([
      { question_no: "1.1", contract_excerpt: "", answer_reason: "无依据" },
      { question_no: "1.1", contract_excerpt: "第三条约定……", answer_reason: "引用第三条" },
      { question_no: "1.2", contract_excerpt: "付款条件" },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged.find((item) => item.question_no === "1.1")?.answer_reason).toBe(
      "引用第三条",
    );
  });

  it("ignores responses that name no question", () => {
    expect(mergeRevenueAnswers([{ contract_excerpt: "孤立内容" }])).toHaveLength(0);
  });
});
