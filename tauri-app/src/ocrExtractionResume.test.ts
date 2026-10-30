import { describe, expect, it, vi } from "vitest";
import { extractOcrScenario, loadOcrScenarios } from "./ocrScenarios";
import { ocrExtractionKey, type OcrExtractionCache, type OcrVerifiedResponse, type OcrExtractionDiagnostic } from "./ocrExtractionResume";
import type { OcrPageData } from "./ocrTypes";

vi.mock("./audipickCaseLibrary", async original => {
  const actual = await original<typeof import("./audipickCaseLibrary")>();
  return { ...actual, loadCaseLibraryState: vi.fn(async () => ({ active: { library: actual.DEFAULT_CASE_LIBRARY } })) };
});
const page = (text: string, number = 1): OcrPageData => ({ page: number, text, originalText: text, tables: [], originalTables: [], revision: 1, status: "completed", warnings: [] });
function cacheFor(entries = new Map<string, OcrVerifiedResponse>(), contextKey = "a".repeat(64)): OcrExtractionCache {
  return { contextKey, get: async key => structuredClone(entries.get(key) ?? null), put: async (key, value) => { entries.set(key, structuredClone(value)); return true; } };
}
const response = (items: Record<string, unknown>[] = []) => ({ parsed: { coverage_complete: true as const, items } });
const document = { id: "resume-contract", name: "合同.pdf" };

describe("已核验摘录断点续跑", () => {
  it("失败只保留已核验段，重试跳过这些段，整次命中仍逐段核验且结果一致", async () => {
    const scenario = (await loadOcrScenarios()).find(s => s.id === "loan_restrictive")!;
    const pages = [1, 2, 3].map(n => page(`第${n}页借款人不得用于股权投资。\n` + "合同说明。".repeat(440), n));
    const entries = new Map<string, OcrVerifiedResponse>(); const cache = cacheFor(entries);
    let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const diagnostics: OcrExtractionDiagnostic[] = [];
    const first = extractOcrScenario({ scenario, stages: scenario.defaultPrompts, document, pages, cache,
      onDiagnostic: entry => diagnostics.push(entry), request: async () => { if (++calls === 1) { await pending; return response(); } throw new Error("网络中断"); } });
    const outcome = first.catch((error: Error) => error.message);
    await vi.waitFor(() => expect(calls).toBe(2)); release();
    expect(await outcome).toContain("网络中断"); expect(entries.size).toBe(1);
    expect(diagnostics.map(entry => entry.status).sort()).toEqual(["transport_error", "validated"]);
    const retry = vi.fn(async () => response());
    const result = await extractOcrScenario({ scenario, stages: scenario.defaultPrompts, document, pages, cache, request: retry });
    expect(retry).toHaveBeenCalledTimes(2); expect(entries.size).toBe(3);
    const neverRequest = vi.fn(async () => { throw new Error("不应重复请求"); });
    const replay = await extractOcrScenario({ scenario, stages: scenario.defaultPrompts, document, pages, cache, request: neverRequest });
    expect(replay).toEqual(result); expect(neverRequest).not.toHaveBeenCalled();
  });

  it("提示词、原文和模型上下文变化不复用，损坏证据缓存重新请求", async () => {
    const scenario = (await loadOcrScenarios()).find(s => s.id === "custom")!;
    const pages = [page("本金为00123元。")]; const entries = new Map<string, OcrVerifiedResponse>();
    const request = vi.fn(async () => response([{ 本金: "00123元", evidence_refs: [{ line_start: 1, line_end: 1 }] }]));
    const options = { scenario, stages: [{ ...scenario.defaultPrompts[0], prompt: "提取本金" }], document, pages, cache: cacheFor(entries), request };
    const first = await extractOcrScenario(options); expect(request).toHaveBeenCalledTimes(1);
    expect(first.columns.some(c => /证据|原文/.test(c.label))).toBe(false);
    expect(first.rows[0].evidence).toBe(pages[0].text);
    expect(await extractOcrScenario(options)).toEqual(first); expect(request).toHaveBeenCalledTimes(1);
    await extractOcrScenario({ ...options, stages: [{ ...options.stages[0], prompt: "提取本金，保留单位" }] });
    await extractOcrScenario({ ...options, pages: [page("本金为00123元。\n另一说明。", 1)] });
    await extractOcrScenario({ ...options, cache: cacheFor(entries, "b".repeat(64)) });
    expect(request).toHaveBeenCalledTimes(4);
    for (const key of entries.keys()) entries.set(key, response([{ 本金: "00123元", evidence_refs: [{ line_start: 999, line_end: 999 }] }]));
    await extractOcrScenario(options); expect(request).toHaveBeenCalledTimes(5);
  });

  it("数字字符串行号本地规范化，不改业务金额、不多发修复请求", async () => {
    const scenario = (await loadOcrScenarios()).find(s => s.id === "custom")!;
    const request = vi.fn(async () => response([{ 本金: "00123元", evidence_refs: [{ line_start: "1", line_end: "1" }] }]));
    const result = await extractOcrScenario({ scenario, stages: [{ ...scenario.defaultPrompts[0], prompt: "提取本金" }], document, pages: [page("本金为00123元。")], request });
    expect(result.rows[0].本金).toBe("00123元"); expect(request).toHaveBeenCalledTimes(1);
    expect(result.rows[0].evidence).toBe("本金为00123元。");
  });

  it("完整性为false的结果不缓存，修复成功后缓存合并的有效结果", async () => {
    const scenario = (await loadOcrScenarios()).find(s => s.id === "invoice")!;
    const entries = new Map<string, OcrVerifiedResponse>(); let calls = 0;
    const diagnostics: OcrExtractionDiagnostic[] = [];
    await extractOcrScenario({ scenario, stages: scenario.defaultPrompts, document, pages: [page("发票100元")], cache: cacheFor(entries), onDiagnostic: value => diagnostics.push(value),
      request: async () => ++calls === 1 ? { parsed: { coverage_complete: false, items: [] } } : response() });
    expect(calls).toBe(2); expect(entries.size).toBe(1);
    expect(diagnostics.map(value => [value.status, value.reason])).toEqual([["rejected", "coverage"], ["validated", undefined]]);
    expect(Object.keys(diagnostics[0])).not.toContain("text");
  });

  it("稳定键不受对象键顺序影响，业务内容变化必须改变键", async () => {
    expect(await ocrExtractionKey({ b: 2, a: { y: 1, x: 2 } })).toBe(await ocrExtractionKey({ a: { x: 2, y: 1 }, b: 2 }));
    expect(await ocrExtractionKey({ a: 1 })).not.toBe(await ocrExtractionKey({ a: 2 }));
  });

  it("大段不完整立即拆分，合并并重新核验行号后保存父段，重开不重复大段或子段", async () => {
    const scenario = (await loadOcrScenarios()).find(s => s.id === "custom")!;
    const entries = new Map<string, OcrVerifiedResponse>();
    const pages = [page(["本金600万元。", ...Array(30).fill("补充说明。".repeat(15)), "借款期限12个月。"].join("\n"))];
    const inputs: string[] = [];
    const result = await extractOcrScenario({ scenario, stages: [{ ...scenario.defaultPrompts[0], prompt: "提取本金及期限" }], document, pages, cache: cacheFor(entries),
      request: async ({ prompt, text }) => {
        inputs.push(text);
        if (prompt.includes("【汇总返回契约】")) return response([{ 本金: "600万元", 借款期限: "12个月", evidence_ids: ["E1", "E2"] }]);
        if (text.includes("本金600万元") && text.includes("借款期限12个月")) return { parsed: { coverage_complete: false, items: [] } };
        const match = [...text.matchAll(/^\[L(\d+)\]\[PDF第\d+页\](.*)$/gm)].find(m => /本金|借款期限/.test(m[2]))!;
        return response([{ [match[2].startsWith("本金") ? "本金" : "借款期限"]: match[2].startsWith("本金") ? "600万元" : "12个月", evidence_refs: [{ line_start: Number(match[1]), line_end: Number(match[1]) }] }]);
      } });
    expect(inputs.filter(text => text.includes("[L") && text.includes("本金600万元") && text.includes("借款期限12个月"))).toHaveLength(1);
    const request = vi.fn(async () => { throw new Error("不应重新请求"); });
    const replay = await extractOcrScenario({ scenario, stages: [{ ...scenario.defaultPrompts[0], prompt: "提取本金及期限" }], document, pages, cache: cacheFor(entries), request });
    expect(replay).toEqual(result); expect(request).not.toHaveBeenCalled();
  });
});
