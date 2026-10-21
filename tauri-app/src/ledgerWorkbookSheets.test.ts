import { describe, expect, it, vi } from "vitest";
import {
  classifyLedgerWorkbookSheets,
  correctLedgerSourceKinds,
  ledgerClassificationIsVisible,
  scanLedgerUploadSources,
  selectLedgerSourcePair,
  selectLedgerWorkbookKindSources,
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
  it("参数说明页不会撤销同本工作簿已识别的数据表，单独参数工作簿仍报告原因", async () => {
    const failure = { code: "SOURCE_NOT_TABULAR", userMessage: "该工作表是参数／说明页，没有常规表头。" };
    const call = vi.fn(async (_method: string, params: Record<string, unknown>) => {
      const source = params.source as { inputPath: string; sheet: string };
      if (source.inputPath === "参数.xlsx" || source.sheet === "参数与口径") throw failure;
      return classification(source.sheet || "TB", ["TB", "参数与口径"], { je: 1, tb: 10 });
    });
    const result = await scanLedgerUploadSources(call, ["账套.xlsx", "参数.xlsx"]);
    expect(result.sources.map(item => item.classification.sheet)).toEqual(["TB"]);
    expect(result.hiddenSheets).toBe(1);
    expect(result.failures).toEqual([{ path: "参数.xlsx", error: failure }]);
  });
  it.each([false, true])("空白 Sheet 不丢弃有效 TB，也不阻断后续 JE（空白页在前：%s）", async (emptyFirst) => {
    const names = emptyFirst ? ["空白", "TB", "JE"] : ["TB", "空白", "JE"];
    const call = vi.fn(async (_method: string, params: Record<string, unknown>) => {
      const sheet = (params.source as { sheet: string }).sheet;
      if (sheet === "空白") throw { code: "SOURCE_EMPTY", userMessage: "文件中没有可读取的数据。" };
      return classification(sheet || "TB", names, sheet === "JE" ? { je: 10, tb: 1 } : { je: 1, tb: 10 });
    });
    const result = await scanLedgerUploadSources(call, ["账套.xlsx"]);
    expect(result.sources.map((item) => item.classification.sheet)).toEqual(["TB", "JE"]);
    expect(result.hiddenSheets).toBe(1);
    expect(result.failures).toEqual([]);
    expect(selectLedgerSourcePair(result.sources).map((item) => item.kind).sort()).toEqual(["je", "tb"]);
  });

  it("整个工作簿为空时仍报告错误，不影响另一份 JE", async () => {
    const empty = { code: "SOURCE_EMPTY", userMessage: "工作簿中没有可读取的数据Sheet。" };
    const call = vi.fn(async (_method: string, params: Record<string, unknown>) => {
      if ((params.source as { inputPath: string }).inputPath === "空表.xlsx") throw empty;
      return classification("JE", ["JE"]);
    });
    const result = await scanLedgerUploadSources(call, ["空表.xlsx", "je.xlsx"]);
    expect(result.sources.map((item) => item.path)).toEqual(["je.xlsx"]);
    expect(result.failures).toEqual([{ path: "空表.xlsx", error: empty }]);
    expect(result.hiddenSheets).toBe(0);
  });

  it.each([
    { code: "SOURCE_READ_FAILED", userMessage: "读取工作表失败。" },
    { code: "JOB_CANCELLED", userMessage: "任务已取消。" },
    new Error("文件中没有可读取的数据。"),
  ])("非 SOURCE_EMPTY 错误不能被当作空白 Sheet 忽略（%s）", async (failure) => {
    const call = vi.fn(async (_method: string, params: Record<string, unknown>) => {
      if ((params.source as { sheet: string }).sheet) throw failure;
      return classification("TB", ["TB", "另一张表"], { je: 1, tb: 10 });
    });
    const result = await scanLedgerUploadSources(call, ["账套.xlsx"]);
    expect(result.failures).toEqual([{ path: "账套.xlsx", error: failure }]);
    expect(result.hiddenSheets).toBe(0);
  });

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

  it("透视、check、核对和账表种类辅助 Sheet 即使分数较高也不参与配对", () => {
    for (const sheet of [
      "透视check",
      "Pivot Table",
      "内部核对表",
      "je种类",
      "TB_类型",
    ]) {
      expect(
        ledgerClassificationIsVisible(
          classification(sheet, undefined, { je: 1, tb: 11 }),
        ),
      ).toBe(false);
    }
  });

  it("同一工作簿同一类型只保留一个自动来源，其他 Sheet 留给下拉手选", () => {
    const path = "C:/x/06科目余额表_2024.1-3.xlsx";
    const selected = selectLedgerWorkbookKindSources([
      {
        path,
        classification: classification("Sheet1", ["Sheet1", "Sheet2"], {
          je: 1,
          tb: 9,
        }),
      },
      {
        path,
        classification: classification("Sheet2", ["Sheet1", "Sheet2"], {
          je: 1,
          tb: 10,
        }),
      },
    ]);
    // 第一项是 Rust 按规模等证据选出的工作簿正表，不因辅助页表头分高 1 分而重复建组。
    expect(selected.map((item) => item.classification.sheet)).toEqual(["Sheet1"]);
  });

  it("文件名明确写 JE 时不让其中的辅助 Sheet 反向生成 TB 组", () => {
    const path = "C:/x/04JE.XLSX";
    const selected = selectLedgerWorkbookKindSources([
      {
        path,
        classification: classification("Sheet1", ["Sheet1", "处理"], {
          je: 9,
          tb: 1,
        }),
      },
      {
        path,
        classification: classification("处理", ["Sheet1", "处理"], {
          je: 2,
          tb: 8,
        }),
      },
    ]);
    expect(selected).toHaveLength(1);
    expect(selected[0].classification).toMatchObject({ kind: "je", sheet: "Sheet1" });
  });

  it("公共扫描入口统一过滤低置信度并保留 LLM 失败时的规则结果", async () => {
    const call = vi.fn(
      async (
        method: string,
        params: Record<string, unknown>,
        _busyDetail?: string,
      ) => {
        if (method === "tool.classify_llm") throw new Error("offline");
        const sheet = (params.source as { sheet: string }).sheet;
        if (!sheet)
          return {
            ...classification("TB", ["TB", "说明"], { je: 4, tb: 5 }),
            needsLlm: true,
          };
        return classification("说明", ["TB", "说明"], { je: 1, tb: 1 });
      },
    );
    const result = await scanLedgerUploadSources(call, ["C:/x/账套.xlsx"], {
      llmMethod: "tool.classify_llm",
    });
    expect(result.sources.map((item) => item.classification.sheet)).toEqual(["TB"]);
    expect(result.hiddenSheets).toBe(1);
    expect(result.llmFallbacks).toBe(1);
    // 等待弹窗明细只留文件名＋Sheet：LLM 复核慢，用户要能看出在复核哪张表。
    const llmCall = call.mock.calls.find(([m]) => m === "tool.classify_llm");
    expect(llmCall?.[2]).toBe("账套.xlsx / TB");
  });

  it("高置信度分类明确不需要 LLM 时跳过类型复核", async () => {
    const call = vi.fn(async (method: string) => {
      if (method === "tool.classify_llm")
        throw new Error("高置信度文件不应调用 LLM");
      return classification("JE", ["JE"], { je: 12, tb: 3 });
    });
    const result = await scanLedgerUploadSources(call, ["C:/x/序时账.xls"], {
      llmMethod: "tool.classify_llm",
    });
    expect(result.sources).toHaveLength(1);
    expect(result.llmFallbacks).toBe(0);
    expect(call.mock.calls.map(([method]) => method)).toEqual([
      "deposit.classify_source",
    ]);
  });

  it("多工作簿识别最多并行两份，合并结果仍保持选入顺序", async () => {
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const call = vi.fn(
      async (_method: string, params: Record<string, unknown>) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        const path = (params.source as { inputPath: string }).inputPath;
        return classification(path.split("/").pop()!, [path.split("/").pop()!]);
      },
    );
    const started: string[] = [];
    const running = scanLedgerUploadSources(
      call,
      ["C:/x/1.xlsx", "C:/x/2.xlsx", "C:/x/3.xlsx"],
      { onWorkbookStart: (path) => started.push(path) },
    );

    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(maxActive).toBe(2);
    releases.shift()?.();
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(3));
    expect(maxActive).toBe(2);
    releases.splice(0).forEach((release) => release());

    const result = await running;
    expect(started).toEqual([
      "C:/x/1.xlsx",
      "C:/x/2.xlsx",
      "C:/x/3.xlsx",
    ]);
    expect(result.sources.map((item) => item.path)).toEqual([
      "C:/x/1.xlsx",
      "C:/x/2.xlsx",
      "C:/x/3.xlsx",
    ]);
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
