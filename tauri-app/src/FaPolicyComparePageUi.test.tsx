// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { engineCall, pickPath } from "./api";
import { FaPolicyComparePage } from "./FaPolicyComparePage";
import type { JobEvent, ToolManifest } from "./types";

let currentJob: JobEvent | undefined;
vi.mock("./api", () => ({
  engineCall: vi.fn(), jobCancel: vi.fn(), jobStart: vi.fn(),
  listenJobEvents: vi.fn(async () => () => undefined),
  listenPositionedFileDrops: vi.fn(async () => () => undefined),
  openOutput: vi.fn(), pickPath: vi.fn(),
}));
vi.mock("./hooks/useJobEvents", () => ({
  useJobEvents: () => ({ job: currentJob, setJob: vi.fn() }),
}));
vi.mock("./restore", () => ({ useTaskRestore: vi.fn() }));

const tool: ToolManifest = {
  id: "fa_policy_compare", name: "折旧政策对比", description: "",
  route: "/tools/fa_policy_compare", version: "test", capabilities: [],
  migrationStatus: "ready",
};

afterEach(() => {
  currentJob = undefined;
  vi.mocked(engineCall).mockReset();
  vi.mocked(pickPath).mockReset();
  cleanup();
});

function renderExport(job?: JobEvent) {
  currentJob = job;
  const result = render(<FaPolicyComparePage tool={tool} />);
  fireEvent.click(screen.getByRole("button", { name: "2 导出" }));
  return result;
}

function event(phase: JobEvent["phase"]): JobEvent {
  return {
    jobId: `policy-${phase}`, toolId: tool.id, phase,
    current: 1, total: 1, message: phase === "failed" ? "导出失败，请检查文件。" : "任务已取消。",
    severity: phase === "failed" ? "error" : "warning", outputPaths: [],
  };
}

it("尚未导出时显示等待结果", () => {
  renderExport();
  expect(screen.getByText("等待结果")).toBeVisible();
});

it.each(["failed", "cancelled"] as const)("%s 后显示任务状态，不再声称等待结果", (phase) => {
  const { container } = renderExport(event(phase));
  expect(container.querySelector(`[data-job-state="${phase}"]`)).toBeInTheDocument();
  expect(screen.queryByText("等待结果")).not.toBeInTheDocument();
});

it("导出结束但没有返回文件时给出可执行的下一步", () => {
  renderExport(event("completed"));
  expect(screen.queryByText("等待结果")).not.toBeInTheDocument();
  expect(screen.getByText("任务没有返回可打开的结果文件，请检查保存位置。")).toBeVisible();
});

it("期末 LLM 建议生效后，对应预览表头下拉显示本年折旧", async () => {
  vi.mocked(pickPath)
    .mockResolvedValueOnce("C:\\begin.xlsx")
    .mockResolvedValueOnce("C:\\end.xlsx");
  vi.mocked(engineCall).mockImplementation(async (method) => {
    if (method === "fa.inspect") return {
      begin: { headers: ["卡片编号"], preview: [["A1"]], sheets: ["Data"], selectedSheet: "Data", detectedHeaderRow: 1, dimensions: { rows: 1, columns: 1 } },
      end: { headers: ["卡片编号", "本年至今折旧（会计准"], preview: [["A1", "100"]], sheets: ["Data"], selectedSheet: "Data", detectedHeaderRow: 1, dimensions: { rows: 1, columns: 2 } },
      suggestedMapping: { begin: { matchKeys: ["卡片编号"] }, end: { matchKeys: ["卡片编号"] } },
    } as never;
    if (method === "fa.review") return {
      enabled: true, passed: true, message: "LLM 映射复核完成。",
      autoApplied: [{ role: "current_year_dep", file_side: "file2", suggested_column: "本年至今折旧(会计准", confidence: 0.95, action: "fill" }],
      fieldReviews: [], matchReview: { action: "keep" },
    } as never;
    throw new Error(`Unexpected method: ${method}`);
  });
  render(<FaPolicyComparePage tool={tool} />);
  fireEvent.click(screen.getByRole("button", { name: /1 文件与匹配/ }));
  fireEvent.click(screen.getByText("拖放或点击选择年初清单"));
  await screen.findByText("begin.xlsx");
  fireEvent.click(screen.getByText("拖放或点击选择年末清单"));
  const select = await screen.findByTitle("本年折旧");
  expect(select).toHaveValue("currentYearDep");
  expect(screen.getByText("期末 本年折旧")).toBeVisible();
});
