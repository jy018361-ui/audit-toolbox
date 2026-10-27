import { describe, expect, it, vi } from "vitest";
import { extractOcrScenario, getOcrPromptStages, loadOcrScenarios } from "./ocrScenarios";
import { extractFinancialMetrics, FINANCIAL_METRICS_PROMPT } from "./audipickCovenantExtraction";
import type { OcrPageData } from "./ocrTypes";
import { OcrDocumentDetailSchema, OcrProjectSchema } from "./ocrTypes";
import { handlers as demoHandlers, jobHandlers as demoJobHandlers } from "./preview/demo/ocr";

vi.mock("./audipickCaseLibrary", async (original) => {
  const actual = await original<typeof import("./audipickCaseLibrary")>();
  return { ...actual, loadCaseLibraryState: vi.fn(async () => ({ active: { library: actual.DEFAULT_CASE_LIBRARY } })) };
});

describe("OCR 浏览器演示契约", () => {
  it("预置可解码 PNG、两份单证、表格、人工修订和失效摘录", () => {
    const saved = demoHandlers["ocr.projects"]({}) as { projects: unknown[] };
    const project = OcrProjectSchema.parse(saved.projects[0]);
    const listing = demoHandlers["ocr.documents"]({ projectId: project.id }) as { documents: { id: string }[] };
    expect(listing.documents).toHaveLength(2);
    const docs = listing.documents.map((document) => OcrDocumentDetailSchema.parse(demoHandlers["ocr.document"]({ documentId: document.id })));
    expect(docs[0].pages[0].tables[0].rows[1][1]).toBe("00123456789012345678");
    expect(docs[1].document.revision).toBeGreaterThan(docs[1].extractions[0].sourceRevision);
    const image = demoHandlers["ocr.document_bytes"]({ documentId: docs[0].document.id }) as { mimeType: string; dataBase64: string };
    expect(image.mimeType).toBe("image/png");
    expect(Array.from(atob(image.dataBase64).slice(0, 8), (character) => character.charCodeAt(0))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(project.prompts.custom[0].prompt).toContain("演示项目");
  });

  it("项目 prompt 内存保存生效，识别完成事件前不提前写入页面", () => {
    const created = OcrProjectSchema.parse(demoHandlers["ocr.project_save"]({ name: "独立演示测试项目" }));
    const prompts = { custom: [{ id: "extract", label: "自定义", prompt: "修改后的演示 prompt" }] };
    const updated = OcrProjectSchema.parse(demoHandlers["ocr.project_save"]({ id: created.id, name: created.name, prompts }));
    expect(updated.prompts).toEqual(prompts);
    const imported = demoHandlers["ocr.document_import"]({ projectId: created.id, paths: ["fixture.png"] }) as { documents: { id: string }[] };
    const documentId = imported.documents[0].id;
    const events = demoJobHandlers["ocr.recognize_page"]({ documentId, page: 1, expectedRevision: 0 });
    expect(OcrDocumentDetailSchema.parse(demoHandlers["ocr.document"]({ documentId })).pages).toHaveLength(0);
    expect(events.at(-1)!.result).toMatchObject({ page: 1, status: "completed" });
    expect(OcrDocumentDetailSchema.parse(demoHandlers["ocr.document"]({ documentId })).pages).toHaveLength(1);
    demoHandlers["ocr.project_delete"]({ id: created.id });
    expect(() => demoHandlers["ocr.document"]({ documentId })).toThrow("不存在");
  });
});

const page = (text: string, number = 1): OcrPageData => ({ page: number, text, originalText: text, tables: [], originalTables: [], revision: 1, status: "completed", warnings: [] });
const document = { id: "d1", name: "测试单证.pdf" };
const response = (items: Record<string, unknown>[], extra = {}) => ({ parsed: { coverage_complete: true, items }, ...extra });
const scenario = async (id: string) => (await loadOcrScenarios()).find((item) => item.id === id)!;

describe("OCR 场景默认提示词与逐字来源", () => {
  it("读取所有维护中的通用场景及完整默认 prompt，排除收入底稿专门流程", async () => {
    const all = await loadOcrScenarios();
    expect(all.map((item) => item.id)).toEqual(["loan_covenant", "loan_general", "revenue", "procurement", "invoicing_agreement", "statement", "invoice", "warehouse_io", "account_opening", "tax_declaration", "credit_report", "tax_audit_report", "custom"]);
    for (const item of all) {
      expect(item.name).not.toBe(item.id);
      expect(item.version).toBeTruthy();
      expect(item.fields.length).toBeGreaterThan(0);
      expect(item.defaultPrompts[0].prompt.length).toBeGreaterThan(150);
    }
    expect(all.find((item) => item.id === "loan_covenant")!.defaultPrompts[0].prompt).toBe(FINANCIAL_METRICS_PROMPT);
    expect(all.find((item) => item.id === "invoice")!.defaultPrompts[0].prompt).toContain("invoice_no: 发票号码");
    expect(all.find((item) => item.id === "loan_general")!.defaultPrompts).toHaveLength(2);
  });

  it("项目 prompt 覆写用于实际请求，恢复默认不受其他项目修改影响", async () => {
    const selected = await scenario("custom");
    const edited = getOcrPromptStages(selected, { custom: [{ ...selected.defaultPrompts[0], prompt: "用户编辑后的完整 prompt" }] });
    const request = vi.fn(async () => response([{ category: "金额", excerpt: "金额：001234", pages: "第99页" }]));
    const result = await extractOcrScenario({ scenario: selected, stages: edited, document, pages: [page("金额：001234", 7)], request });
    expect(request.mock.calls[0]).toEqual([{ prompt: "用户编辑后的完整 prompt", text: expect.stringContaining("---PDF第7页---") }]);
    expect(result.rows[0]).toMatchObject({ sourceFile: document.name, sourcePage: "7", pages: "7", evidence: "金额：001234" });
    edited[0].prompt = "再次修改";
    expect(getOcrPromptStages(selected)[0].prompt).toContain("通用单证摘录助手");
    expect(selected.defaultPrompts[0].prompt).toContain("通用单证摘录助手");
  });

  it("不会使用模型伪造页码或为无证据表格杜撰原文", async () => {
    const selected = await scenario("invoice");
    const result = await extractOcrScenario({ scenario: selected, stages: getOcrPromptStages(selected), document, pages: [page("发票号码：001234", 4)], request: async () => response([{ invoice_no: "001234", pages: "第999页" }]) });
    expect(result.rows[0]).toMatchObject({ invoice_no: "001234", pages: "", sourcePage: "", evidence: "" });
    expect(result.rows[0].source_reference).toContain("未提供逐字证据，具体出处待核对");
    expect(result.rows[0].source_reference).toContain("第4页");
  });

  it("拒绝改写或虚构的引用，非连续真实证据逐段验证后定位", async () => {
    const selected = await scenario("custom");
    const options = { scenario: selected, stages: getOcrPromptStages(selected), document, pages: [page("金额为100元。\n开票人为甲公司。", 2), page("税额13元。", 3)] };
    await expect(extractOcrScenario({ ...options, request: async () => response([{ excerpt: "金额为200元。" }]) })).rejects.toThrow("无法逐字");
    const result = await extractOcrScenario({ ...options, request: async () => response([{ excerpt: "模型改写摘要", evidence_quotes: ["金额为100元。", "税额13元。"] }]) });
    expect(result.rows[0]).toMatchObject({ sourcePage: "2、3", excerpt: "金额为100元。\n\n税额13元。", evidence: "金额为100元。\n\n税额13元。" });
  });

  it("长文分段覆盖尾部且只允许引用本次送出的范围", async () => {
    const selected = await scenario("custom");
    const source = "无关说明。".repeat(6_000) + "尾部唯一证据。";
    const request = vi.fn(async ({ text }: { prompt: string; text: string }) => response(text.includes("尾部唯一证据。") ? [{ excerpt: "尾部唯一证据。" }] : []));
    const result = await extractOcrScenario({ scenario: selected, stages: getOcrPromptStages(selected), document, pages: [page(source, 9)], request });
    expect(request.mock.calls.length).toBeGreaterThan(1);
    expect(request.mock.calls.every(([input]) => input.text.length < 12_200)).toBe(true);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].sourcePage).toBe("9");
    await expect(extractOcrScenario({ scenario: selected, stages: getOcrPromptStages(selected), document, pages: [page(source)], request: async () => response([{ excerpt: "尾部唯一证据。" }]) })).rejects.toThrow("本轮来源");
  });

  it("输出截断、未完整检查、损坏 JSON 不会被当作零项成功", async () => {
    const selected = await scenario("custom");
    const options = { scenario: selected, stages: getOcrPromptStages(selected), document, pages: [page("正文")] };
    await expect(extractOcrScenario({ ...options, request: async () => response([], { finish_reason: "length" }) })).rejects.toThrow("截断");
    await expect(extractOcrScenario({ ...options, request: async () => ({ parsed: { coverage_complete: false, items: [] } }) })).rejects.toThrow("检查完整");
    await expect(extractOcrScenario({ ...options, request: async () => ({ raw: "损坏 JSON" }) })).rejects.toThrow("有效 JSON");
    await expect(extractOcrScenario({ ...options, request: async () => ({ parsed: { items: [] } }) })).rejects.toThrow("检查完整");
  });

  it("财务契约使用用户 prompt 和启用案例，但原文仍按行号回填", async () => {
    const selected = await scenario("loan_covenant");
    const stages = getOcrPromptStages(selected);
    stages[0].prompt = "自定义财务契约关注事项";
    const request = vi.fn(async ({ text }: { prompt: string; text: string }) => {
      const line = Number(text.match(/\[L(\d+)\]借款人资产负债率不得超过65%/)?.[1]);
      return response([{ title: "资产负债率", evidence: [{ line_start: line, line_end: line, role: "obligation" }] }]);
    });
    const result = await extractOcrScenario({ scenario: selected, stages, document, pages: [page("借款人资产负债率不得超过65%。", 6)], request });
    expect(request.mock.calls[0][0].prompt).toContain("自定义财务契约关注事项");
    expect(request.mock.calls[0][0].prompt).toContain("本轮启用案例库版本");
    expect(result.rows[0]).toMatchObject({ excerpt: "借款人资产负债率不得超过65%。", sourcePage: "6", evidence: "借款人资产负债率不得超过65%。" });
    await expect(extractOcrScenario({ scenario: selected, stages, document, pages: [page("借款人资产负债率不得超过65%。")], request: async () => response([{ evidence: [{ line_start: 9999 }] }]) })).rejects.toThrow("超出");
  });

  it("借款长文汇总阶段可编辑并实际合并分段，不按页新增借款", async () => {
    const selected = await scenario("loan_general");
    const stages = getOcrPromptStages(selected);
    stages[1].prompt = "用户修改的整份主表合并规则";
    const request = vi.fn(async ({ prompt, text }: { prompt: string; text: string }) => response(text.includes("合同编号A001。") ? [{ contract_no: "A001", excerpt: "合同编号A001。", ...(prompt === stages[1].prompt ? { auditor_summary: "已核对整份合同" } : {}) }] : []));
    const result = await extractOcrScenario({ scenario: selected, stages, document, pages: [page("合同编号A001。" + "普通说明。".repeat(3_000))], request });
    expect(request.mock.calls.at(-1)![0].prompt).toBe(stages[1].prompt);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].auditor_summary).toBe("已核对整份合同");
  });

  it("校对后的表格单元格进入摘录上下文", async () => {
    const selected = await scenario("custom");
    const source = page("金额请见表格");
    source.tables = [{ id: "t1", title: "金额", rows: [["账号", "金额"], ["00123", "777.00"]] }];
    const request = vi.fn(async () => response([{ excerpt: "00123\t777.00" }]));
    const result = await extractOcrScenario({ scenario: selected, stages: getOcrPromptStages(selected), document, pages: [source], request });
    expect(result.rows[0].evidence).toBe("00123\t777.00");
  });

  it("既有 AudiPick 调用省略覆写参数时继续使用原有 prompt", async () => {
    const extract = vi.fn(async (_params: { prompt: string; text: string }) => response([]));
    await extractFinancialMetrics({ documents: [{ ...document, text: "借款人资产负债率不得超过65%。" }], extract });
    expect(extract.mock.calls[0][0].prompt).toContain(FINANCIAL_METRICS_PROMPT);
  });
});
