// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KanzhangParityPage } from "./KanzhangParityPage";
import { publishTaskRestore } from "./restore";
import { jobStart } from "./api";
import type { ToolManifest } from "./types";

let jobEventsCallback: ((event: Record<string, unknown>) => void) | undefined;
vi.mock("./api", () => ({
  engineCall: vi.fn().mockResolvedValue({ values: [], total: 0 }),
  jobCancel: vi.fn(),
  jobStart: vi.fn().mockResolvedValue("job-restore-1"),
  listenJobEvents: vi.fn().mockImplementation((cb) => {
    jobEventsCallback = cb;
    return Promise.resolve(() => undefined);
  }),
  openOutput: vi.fn(),
  pickPath: vi.fn().mockResolvedValue(null),
}));

const tool: ToolManifest = {
  id: "kanzhang",
  name: "看账工具",
  description: "",
  route: "/tools/kanzhang",
  version: "test",
  capabilities: [],
  migrationStatus: "ready",
};

const DRAFT_CACHE = "audit-toolbox.kanzhang.draft.v4";

describe("kanzhang history resume", () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.clearAllMocks();
    jobEventsCallback = undefined;
  });

  it("auto re-reads the archived file and keeps the archived mapping over suggestions", async () => {
    // 历史页点击「继续任务」：恢复包在页面挂载前发布（toolId 命中看账）。
    publishTaskRestore({
      jobId: "j1",
      toolId: "kanzhang",
      method: "kanzhang.export",
      params: {
        inputPath: "C:/tmp/je.xlsx",
        sheet: "",
        headerRow: 1,
        mapping: {
          id: ["凭证号"],
          accountCode: "科目编码",
          date: "凭证日期",
          accountName: ["科目名称"],
          summary: "摘要",
          functionalAmount: "金额",
        },
        targetBatches: [{ name: "批次1", accounts: ["管理费用"] }],
        excludeAccounts: ["库存现金"],
        outputPath: "C:/tmp/out.csv",
      },
      missingPaths: [],
      authorizedPathCount: 2,
    });
    render(<KanzhangParityPage tool={tool} />);

    // 恢复后必须自动重新读取文件——映射/批次界面以读取结果为显示前提。
    await waitFor(() =>
      expect(jobStart).toHaveBeenCalledWith("kanzhang.inspect", {
        inputPath: "C:/tmp/je.xlsx",
        sheet: undefined,
        headerRow: 1,
      }),
    );

    // 读取完成：引擎给出的是另一套建议映射，存档映射必须原样保留。
    jobEventsCallback?.({
      toolId: "kanzhang",
      jobId: "job-restore-1",
      phase: "completed",
      result: {
        headers: ["凭证日期", "科目名称", "金额"],
        preview: [["2026-01-01", "管理费用", "100"]],
        dimensions: { rows: 1, columns: 3 },
        sheets: [],
        selectedSheet: "",
        accounts: ["管理费用"],
        accountCount: 1,
        suggestedMapping: {
          date: "自动日期",
          accountName: "自动科目",
          functionalAmount: "自动金额",
        },
      },
    });
    await waitFor(() => {
      const draft = JSON.parse(sessionStorage.getItem(DRAFT_CACHE) ?? "{}");
      expect(draft.mapping?.date).toBe("凭证日期");
      expect(draft.mapping?.accountName).toEqual(["科目名称"]);
      expect(draft.mapping?.functionalAmount).toBe("金额");
      expect(draft.mapping?.id).toEqual(["凭证号"]);
      expect(draft.batches?.[0]?.accounts).toEqual(["管理费用"]);
      expect(draft.excludes).toEqual(["库存现金"]);
      expect(draft.outputPath).toBe("C:/tmp/out.csv");
      // 读取结果已就位：映射预览等的显示前提满足。
      expect(draft.inspect?.headers).toEqual(["凭证日期", "科目名称", "金额"]);
    });
  });

  it("ignores restores without an archived mapping (sub-step jobs)", async () => {
    publishTaskRestore({
      jobId: "j2",
      toolId: "kanzhang",
      method: "kanzhang.inspect",
      params: { inputPath: "C:/tmp/je.xlsx", sheet: "", headerRow: 1 },
      missingPaths: [],
      authorizedPathCount: 1,
    });
    render(<KanzhangParityPage tool={tool} />);
    // 不应用、也不触发读取。
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(jobStart).not.toHaveBeenCalled();
    const draft = JSON.parse(sessionStorage.getItem(DRAFT_CACHE) ?? "{}");
    expect(draft.inputPath ?? "").toBe("");
  });
});
