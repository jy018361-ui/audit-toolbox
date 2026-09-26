// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
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
