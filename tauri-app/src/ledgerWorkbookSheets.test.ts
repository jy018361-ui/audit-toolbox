import { describe, expect, it, vi } from "vitest";
import {
  classifyLedgerWorkbookSheets,
  correctLedgerSourceKinds,
  ledgerClassificationIsVisible,
  scanLedgerUploadSources,
  selectLedgerSourcePair,
  type LedgerWorkbookSheetClassification,
} from "./ledgerMapping";

function classification(
  sheet: string,
  sheets?: string[],
  scores = { je: 8, tb: 1 },
): LedgerWorkbookSheetClassification {
  return {
    kind: scores.tb > scores.je ? "tb" : "je",
    scores,
    confidence: 0.9,
    needsLlm: false,
    sheet,
    sheets,
    headerRow: 1,
    headerDepth: 1,
    headers: ["凭证号"],
    preview: [["记-1"]],
  };
}

describe("工作簿 Sheet 分类", () => {
  it("先取得 Sheet 清单，再逐张按明确 Sheet 分类", async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce(classification("TB", ["TB", "JE", "说明"]))
      .mockResolvedValueOnce(classification("JE", ["TB", "JE", "说明"]))
      .mockResolvedValueOnce(
        classification("说明", ["TB", "JE", "说明"], { je: 0, tb: 0 }),
      );
    const result = await classifyLedgerWorkbookSheets(
      call,
      "fx.classify_source",
      "C:/x/账套.xlsx",
    );
    expect(result.map((item) => item.sheet)).toEqual(["TB", "JE", "说明"]);
    expect(call.mock.calls.map(([, params]) => params.source.sheet)).toEqual([
      "",
      "JE",
      "说明",
    ]);
  });

  it("低于 5 分的 Sheet 不进入上传后的来源 UI", () => {
    expect(ledgerClassificationIsVisible(classification("JE"))).toBe(true);
    expect(
      ledgerClassificationIsVisible(
        classification("说明", undefined, { je: 4, tb: 3 }),
      ),
    ).toBe(false);
  });

  it("透视、check 和核对类辅助 Sheet 即使分数较高也不参与配对", () => {
    for (const sheet of ["透视check", "Pivot Table", "内部核对表"]) {
      expect(
        ledgerClassificationIsVisible(
          classification(sheet, undefined, { je: 1, tb: 11 }),
        ),
      ).toBe(false);
    }
  });

  it("公共扫描入口统一过滤低置信度并保留 LLM 失败时的规则结果", async () => {
    const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "tool.classify_llm") throw new Error("offline");
      const sheet = (params.source as { sheet: string }).sheet;
      if (!sheet) return classification("TB", ["TB", "说明"], { je: 1, tb: 8 });
      return classification("说明", ["TB", "说明"], { je: 1, tb: 1 });
    });
    const result = await scanLedgerUploadSources(call, ["C:/x/账套.xlsx"], {
      llmMethod: "tool.classify_llm",
    });
    expect(result.sources.map((item) => item.classification.sheet)).toEqual(["TB"]);
    expect(result.hiddenSheets).toBe(1);
    expect(result.llmFallbacks).toBe(1);
  });

  it("公共选对入口在所有工具中统一采用同一工作簿优先", () => {
    const sources = [
      { path: "C:/x/账套.xlsx", classification: classification("TB", undefined, { je: 1, tb: 8 }) },
      { path: "C:/x/账套.xlsx", classification: { ...classification("JE"), kind: "je" as const } },
      { path: "C:/x/外部JE.xlsx", classification: classification("JE", undefined, { je: 12, tb: 0 }) },
    ];
    const selected = selectLedgerSourcePair(sources);
    expect(selected.map((item) => item.path)).toEqual([
      "C:/x/账套.xlsx",
      "C:/x/账套.xlsx",
    ]);
  });

  it("公共类型更正会交换已占用的 TB/JE 并按新类型重读", async () => {
    const inspect = vi.fn(async (_kind: "je" | "tb") => ({}));
    const source = (path: string, sheet: string) => ({
      path,
      inspection: { sheet, headerRow: 1, headerDepth: 1 },
    });
    const result = await correctLedgerSourceKinds(
      "je",
      "tb",
      source("C:/x/a.xlsx", "明细"),
      source("C:/x/b.xlsx", "余额"),
      inspect,
    );
    expect(result.map((item) => [item.kind, item.path])).toEqual([
      ["tb", "C:/x/a.xlsx"],
      ["je", "C:/x/b.xlsx"],
    ]);
    expect(inspect.mock.calls.map(([kind]) => kind)).toEqual(["tb", "je"]);
  });
});
