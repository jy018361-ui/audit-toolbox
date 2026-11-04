// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KanzhangParityPage } from "./KanzhangParityPage";
import { publishTaskRestore } from "./restore";
import { engineCall, jobStart } from "./api";
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
  it("取消反馈独立于任务浮层保留在页首", () => {
    const { container } = render(<KanzhangParityPage tool={tool} />);
    act(() => jobEventsCallback?.({ toolId: "kanzhang", jobId: "cancel-test", phase: "cancelled", current: 1, total: 2, message: "任务已取消", severity: "info", outputPaths: [] }));
    expect(screen.getByText("已取消")).toHaveAttribute("data-variant", "warning");
    expect(container.querySelector('[data-variant="warning"]')?.closest('[role="status"]')).toHaveTextContent("可重新读取或运行");
  });
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.clearAllMocks();
    vi.mocked(engineCall).mockResolvedValue({ values: [], total: 0 });
    jobEventsCallback = undefined;
  });

  it.each([0.95, 0.7])("复核修正科目编码后更新默认透视选中项（把握 %s）", async confidence => {
    vi.mocked(engineCall).mockImplementation(async method => method === "kanzhang.llm_mapping" ? {
      reviews: [{ role: "accountCode", currentColumn: "录入时间", suggestedColumn: "总账科目", confidence, reason: "原列为时间，应使用科目编码列" }],
    } : { values: [], total: 0 });
    publishTaskRestore({
      jobId: "pivot-inspect", toolId: "kanzhang", method: "kanzhang.inspect",
      params: { inputPath: "C:/tmp/je.xlsx", headerRow: 1 }, missingPaths: [], authorizedPathCount: 1,
    });
    render(<KanzhangParityPage tool={tool}/>);
    await waitFor(() => expect(jobStart).toHaveBeenCalledWith("kanzhang.inspect", expect.anything()));
    await act(async () => jobEventsCallback?.({
      toolId: "kanzhang", jobId: "job-restore-1", phase: "completed", current: 1, total: 1, message: "已读取", outputPaths: [], severity: "info",
      result: {
        headers: ["凭证日期", "录入时间", "总账科目", "科目名称", "凭证号", "金额"],
        preview: [["2026-05-01", "12:30:00", "160101", "固定资产", "1", "100"]],
        suggestedMapping: { id: ["凭证号"], date: "凭证日期", accountCode: "录入时间", accountName: ["科目名称"], functionalAmount: "金额" },
      },
    }));
    if(confidence < 0.8)fireEvent.click(await screen.findByRole("button", { name: "采纳" }));
    await waitFor(() => {
      const saved = JSON.parse(sessionStorage.getItem(DRAFT_CACHE) ?? "{}");
      expect(saved.mapping.accountCode).toBe("总账科目");
      expect(saved.pivotRows).toEqual(["总账科目", "科目名称"]);
    });
    fireEvent.click(screen.getByRole("button", { name: /透视与导出/ }));
    const rows = screen.getByLabelText("行字段（Ctrl 可多选）") as HTMLSelectElement;
    expect([...rows.selectedOptions].map(option => option.value)).toEqual(["总账科目", "科目名称"]);
    expect([...rows.options].find(option => option.value === "录入时间")?.selected).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /加载与映射/ }));
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    await waitFor(() => expect(JSON.parse(sessionStorage.getItem(DRAFT_CACHE) ?? "{}").pivotRows).toEqual(["录入时间", "科目名称"]));
  });

  it("导出严格使用前端最终显示的编号映射，不恢复已取消的参考列", async () => {
    sessionStorage.setItem(DRAFT_CACHE, JSON.stringify({
      inputPath: "C:/tmp/je.csv", step: 1,
      inspect: {
        headers: ["凭证编号", "参照凭证号", "日期", "科目名称", "金额"],
        preview: [["1", "", "2026-06-01", "固定资产", "100"]],
      },
      mapping: { id: ["凭证编号", "参照凭证号"], date: ["日期"], accountName: ["科目名称"], functionalAmount: "金额" },
      batches: [{ name: "固定资产", accounts: ["固定资产"] }],
    }));
    render(<KanzhangParityPage tool={tool}/>);
    const reference = screen.getByRole("combobox", { name: "将「参照凭证号」映射为字段" });
    expect(reference).toHaveValue("id");
    fireEvent.change(reference, { target: { value: "" } });
    expect(reference).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "将「凭证编号」映射为字段" })).toHaveValue("id");
    fireEvent.click(screen.getByRole("button", { name: /透视与导出/ }));
    fireEvent.click(screen.getByRole("button", { name: "导出结果" }));
    await waitFor(() => expect(jobStart).toHaveBeenCalledWith("kanzhang.export", expect.objectContaining({
      mapping: expect.objectContaining({ id: ["凭证编号"] }),
    })));
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
        headerDepth: 1,
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

  it("re-reads source steps without an archived mapping and uses fresh suggestions", async () => {
    publishTaskRestore({
      jobId: "j2",
      toolId: "kanzhang",
      method: "kanzhang.inspect",
      params: { inputPath: "C:/tmp/je.xlsx", sheet: "", headerRow: 1 },
      missingPaths: [],
      authorizedPathCount: 1,
    });
    render(<KanzhangParityPage tool={tool} />);
    await waitFor(() => expect(jobStart).toHaveBeenCalledWith("kanzhang.inspect", {
      inputPath: "C:/tmp/je.xlsx", sheet: undefined, headerRow: 1, headerDepth: 1,
    }));
    act(() => jobEventsCallback?.({
      toolId: "kanzhang", jobId: "job-restore-1", phase: "completed",
      result: {
        headers: ["科目名称", "金额"], preview: [], dimensions: { rows: 1, columns: 2 },
        sheets: [], selectedSheet: "", accounts: [],
        suggestedMapping: { id: [], accountName: ["科目名称"], date: "", functionalAmount: "金额" },
      },
    }));
    await waitFor(() => {
      const draft = JSON.parse(sessionStorage.getItem(DRAFT_CACHE) ?? "{}");
      expect(draft.inputPath).toBe("C:/tmp/je.xlsx");
      expect(draft.mapping.accountName).toEqual(["科目名称"]);
      expect(draft.inspect.headers).toEqual(["科目名称", "金额"]);
    });
  });
});
