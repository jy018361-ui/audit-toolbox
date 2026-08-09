import { describe, expect, it } from "vitest";
import {
  audipickExportName,
  buildRevenueBatchPrompt,
  buildRevenueQuestionBatches,
  mergeRevenueAnswers,
  buildClassifyPrompt,
  classifySample,
  extractionCacheKey,
  latestFieldSetId,
  matchEvidenceDocument,
  pickClassifiedRule,
  splitContractText,
  withRetry,
  groupRevenueDetailQuestions,
  missingRevenueTargets,
  revenueMissingQuestionFallback,
  revenuePromptForQuestions,
  revenueQuestionKey,
} from "./audipickUi";
import type { RevenueTargetQuestion } from "./audipickUi";

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

describe("latestFieldSetId", () => {
  it("picks the field set of the newest extraction", () => {
    expect(
      latestFieldSetId([
        { fieldSetId: "loan_general:a|b", extractAt: "2026-08-01T00:00:00Z" },
        { fieldSetId: "loan_general:a|b|c", extractAt: "2026-08-09T00:00:00Z" },
        { fieldSetId: "loan_general:a|b", extractAt: "2026-08-02T00:00:00Z" },
      ]),
    ).toBe("loan_general:a|b|c");
  });

  /// A rule update changes the current field set, so results extracted with the
  /// previous one must stay visible rather than silently drop out of the panel.
  it("keeps rows whose field set no longer matches the current selection", () => {
    const rows = [
      { fieldSetId: "loan_general:old", extractAt: "2026-07-01T00:00:00Z" },
    ];
    const visible = latestFieldSetId(rows) ?? "loan_general:new";
    expect(visible).toBe("loan_general:old");
    expect(rows.filter((row) => row.fieldSetId === visible)).toHaveLength(1);
  });

  it("prefers a timestamped extraction over one without a timestamp", () => {
    expect(
      latestFieldSetId([
        { fieldSetId: "a" },
        { fieldSetId: "b", extractAt: "2026-01-01T00:00:00Z" },
      ]),
    ).toBe("b");
  });

  it("returns undefined when nothing records a field set", () => {
    expect(latestFieldSetId([{ extractAt: "2026-01-01T00:00:00Z" }])).toBe(
      undefined,
    );
  });
});

describe("revenue workpaper question targeting", () => {
  const target = (
    over: Partial<RevenueTargetQuestion> = {},
  ): RevenueTargetQuestion => ({
    sheet: "第5步",
    row: 12,
    questionNo: "5.2",
    question: "控制权何时转移？",
    ...over,
  });

  describe("revenueQuestionKey", () => {
    it("reads the catalogue spelling of sheet and question number", () => {
      expect(revenueQuestionKey({ sheet: "第1步", questionNo: "1.1" })).toBe(
        "第1步|1.1",
      );
    });

    it("reads the model-response spelling and trims stray whitespace", () => {
      expect(
        revenueQuestionKey({ workpaper_sheet: " 第1步 ", question_no: " 1.1 " }),
      ).toBe("第1步|1.1");
    });

    it("gives the same key for both spellings of one question", () => {
      expect(revenueQuestionKey({ sheet: "第1步", questionNo: "1.1" })).toBe(
        revenueQuestionKey({ workpaper_sheet: "第1步", question_no: "1.1" }),
      );
    });

    it("survives an item with nothing usable on it", () => {
      expect(revenueQuestionKey({})).toBe("|");
      expect(revenueQuestionKey({ sheet: null, question_no: undefined })).toBe("|");
    });
  });

  describe("revenuePromptForQuestions", () => {
    const base =
      "开头说明\n【底稿问题目录】\n1.1 | 全部问题\n5.2 | 全部问题\n【实务判断口径】\n结尾口径";

    it("replaces the full catalogue with this batch and keeps both sides", () => {
      const prompt = revenuePromptForQuestions(base, [
        target({ questionNo: "5.2", question: "控制权何时转移？" }),
      ]);
      expect(prompt).toContain("开头说明");
      expect(prompt).toContain("【实务判断口径】\n结尾口径");
      expect(prompt).toContain("【本批必须逐项回答的底稿问题】");
      expect(prompt).toContain("第5步 | 第12行 | 5.2 | 控制权何时转移？");
      expect(prompt).not.toContain("【底稿问题目录】");
      expect(prompt).not.toContain("1.1 | 全部问题");
    });

    it("appends the batch when the prompt has no catalogue section", () => {
      const prompt = revenuePromptForQuestions("只有正文口径", [target()]);
      expect(prompt.startsWith("只有正文口径")).toBe(true);
      expect(prompt).toContain("【本批必须逐项回答的底稿问题】");
    });

    it("lists every question of the batch", () => {
      const prompt = revenuePromptForQuestions(base, [
        target({ questionNo: "5.2", row: 12 }),
        target({ questionNo: "5.3", row: 13, question: "是否存在可变对价？" }),
      ]);
      expect(prompt).toContain("第5步 | 第12行 | 5.2 |");
      expect(prompt).toContain("第5步 | 第13行 | 5.3 | 是否存在可变对价？");
    });

    it("carries the confirmed obligations through once even when repeated", () => {
      const prompt = revenuePromptForQuestions(base, [
        target({ questionNo: "5.2", poContext: "PO1：设备交付" }),
        target({ questionNo: "5.3", poContext: "PO1：设备交付" }),
        target({ questionNo: "5.4", poContext: "PO2：安装服务" }),
      ]);
      expect(prompt).toContain("【已确认履约义务及一致性约束】");
      expect(prompt.match(/PO1：设备交付/g)).toHaveLength(1);
      expect(prompt).toContain("PO2：安装服务");
      expect(prompt).toContain("严禁回答“不存在PO”");
    });

    it("drops the obligation constraint when no batch question has context", () => {
      const prompt = revenuePromptForQuestions(base, [target()]);
      expect(prompt).not.toContain("【已确认履约义务及一致性约束】");
      expect(prompt).not.toContain("严禁回答“不存在PO”");
    });
  });

  describe("groupRevenueDetailQuestions", () => {
    it("puts every PO of one timing question in a single ordered group", () => {
      const groups = groupRevenueDetailQuestions([
        target({ questionNo: "5.1.1-a", po_no: "PO1" }),
        target({ questionNo: "5.1.2-a", po_no: "PO1" }),
        target({ questionNo: "5.1.1-a", po_no: "PO2" }),
        target({ questionNo: "5.1.1-b", po_no: "PO1" }),
      ]);
      expect(groups).toHaveLength(3);
      expect(groups[0].map((item) => item.po_no)).toEqual(["PO1", "PO2"]);
      expect(groups[0].every((item) => item.questionNo === "5.1.1-a")).toBe(true);
      expect(groups[1].map((item) => item.questionNo)).toEqual(["5.1.1-b"]);
      expect(groups[2].map((item) => item.questionNo)).toEqual(["5.1.2-a"]);
    });

    it("treats a timing question without a PO as an ordinary one", () => {
      const groups = groupRevenueDetailQuestions([
        target({ questionNo: "5.1.1-a" }),
      ]);
      expect(groups).toHaveLength(1);
      expect(groups[0]).toHaveLength(1);
    });

    it("chunks the remaining questions and keeps all of them", () => {
      const others = Array.from({ length: 13 }, (_, index) =>
        target({ questionNo: `5.${index + 2}`, row: index + 20 }),
      );
      const groups = groupRevenueDetailQuestions(others);
      expect(groups.map((group) => group.length)).toEqual([6, 6, 1]);
      expect(groups.flat().map((item) => item.questionNo)).toEqual(
        others.map((item) => item.questionNo),
      );
    });

    it("returns nothing for an empty catalogue", () => {
      expect(groupRevenueDetailQuestions([])).toEqual([]);
    });
  });

  describe("missingRevenueTargets", () => {
    const targets = [
      target({ sheet: "第1步", questionNo: "1.1" }),
      target({ sheet: "第1步", questionNo: "1.2" }),
      target({ sheet: "第5步", questionNo: "5.2" }),
    ];

    it("returns only the questions the model skipped", () => {
      const missing = missingRevenueTargets(
        [
          { workpaper_sheet: "第1步", question_no: "1.1" },
          { workpaper_sheet: "第5步", question_no: "5.2" },
        ],
        targets,
      );
      expect(missing.map((item) => item.questionNo)).toEqual(["1.2"]);
    });

    it("returns everything when the model answered nothing", () => {
      expect(missingRevenueTargets([], targets)).toHaveLength(3);
    });

    it("does not count an answer filed under another sheet", () => {
      const missing = missingRevenueTargets(
        [{ workpaper_sheet: "第9步", question_no: "1.1" }],
        targets,
      );
      expect(missing.map((item) => item.questionNo)).toEqual(["1.1", "1.2", "5.2"]);
    });
  });

  describe("revenueMissingQuestionFallback", () => {
    it("keeps the workpaper row addressable and flags it for review", () => {
      const row = revenueMissingQuestionFallback(
        target({ sheet: "第5步", row: 12, questionNo: "5.2", question: "控制权何时转移？" }),
      );
      expect(row).toMatchObject({
        workpaper_sheet: "第5步",
        workpaper_row: "12",
        question_no: "5.2",
        question_description: "控制权何时转移？",
        suggested_answer: "",
        fill_readiness: "资料不足",
        confidence: "低",
        review_status: "需人工复核",
        technical_fallback: true,
      });
    });

    it("is recognised as missing again if it is fed back in", () => {
      const question = target({ sheet: "第5步", questionNo: "5.2" });
      const row = revenueMissingQuestionFallback(question);
      expect(missingRevenueTargets([row], [question])).toHaveLength(0);
    });
  });
});

describe("audipickExportName", () => {
  const date = new Date(2026, 7, 9);

  it("names the export after the contract and what was produced", () => {
    expect(
      audipickExportName({
        fileName: "购销合同.pdf",
        typeLabel: "收入底稿填列清单",
        date,
      }),
    ).toBe("购销合同_收入底稿填列清单_20260809.xlsx");
  });

  it("falls back to the project and client when no single contract is named", () => {
    expect(
      audipickExportName({
        projectName: "样例项目",
        clientName: "样例公司",
        scopeLabel: "全部合同",
        typeLabel: "借款主表",
        date,
      }),
    ).toBe("样例项目_样例公司_全部合同_借款主表_20260809.xlsx");
  });

  it("does not repeat the client when it matches the project", () => {
    expect(
      audipickExportName({ projectName: "同名", clientName: "同名", date }),
    ).toBe("同名_20260809.xlsx");
  });

  /// Contract names carry dates and entity names, so slashes and colons are
  /// routine -- Windows refuses to save either.
  it("strips characters Windows cannot save", () => {
    expect(
      audipickExportName({ fileName: 'A/B:C*D?E"F<G>H|I', date }),
    ).toBe("A_B_C_D_E_F_G_H_I_20260809.xlsx");
  });

  /// The date suffix means a reserved device name is never the whole file name,
  /// so it survives as an ordinary word -- matching the legacy module, which
  /// was compared against directly for this case.
  it("leaves a reserved device name alone once the date is appended", () => {
    expect(audipickExportName({ fileName: "CON", date })).toBe(
      "CON_20260809.xlsx",
    );
  });

  it("falls back to the date alone when nothing identifies the export", () => {
    expect(audipickExportName({}, "zip")).toMatch(/^\d{8}\.zip$/);
  });

  it("stays within the filesystem name limit", () => {
    const name = audipickExportName({ fileName: "长".repeat(400), date });
    expect(name.length).toBeLessThanOrEqual(185);
    expect(name.endsWith(".xlsx")).toBe(true);
  });
});
