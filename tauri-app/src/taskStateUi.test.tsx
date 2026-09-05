// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import catalog from "../public/tool-catalog.json";
import { JobProgress } from "./components/JobProgress";
import { ResultView } from "./components/ResultView";
import { jobPresentation } from "./jobState";
import {
  TASK_STATE_SCENARIOS,
  TASK_STATE_TOOL_IDS,
} from "./preview/TaskStateFixture";
import type { JobEvent } from "./types";

const makeJob = (overrides: Partial<JobEvent> = {}): JobEvent => ({
  jobId: "job-state-fixture",
  toolId: "fx_audit",
  phase: "running",
  current: 20,
  total: 100,
  message: "正在处理",
  severity: "info",
  outputPaths: [],
  ...overrides,
});

afterEach(cleanup);

describe("18 个工具的动态任务状态契约", () => {
  it("状态夹具覆盖目录内全部工具及恢复/部分完成/长任务状态", () => {
    expect([...TASK_STATE_TOOL_IDS].sort()).toEqual(
      catalog.map((tool) => tool.id).sort(),
    );
    expect(TASK_STATE_SCENARIOS).toEqual([
      "loading", "queued", "running", "paused", "cancelled",
      "failed", "completed", "partial", "restored", "history_resume",
    ]);
  });

  it.each([
    ["queued", "排队中", false],
    ["running", "处理中", false],
    ["memory_paused", "已暂停", false],
    ["cancelled", "已取消", true],
    ["failed", "处理失败", true],
    ["completed", "已完成", true],
  ] as const)("将 %s 归一为 %s", (phase, label, terminal) => {
    expect(jobPresentation(makeJob({ phase }))).toMatchObject({ label, terminal });
  });

  it("完成事件含警告、跳过或缺失项时明确标记部分完成", () => {
    expect(jobPresentation(makeJob({ phase: "completed", severity: "warning" })).state).toBe("partial");
    expect(jobPresentation(makeJob({ phase: "completed", result: { skippedPaths: ["C:\\很长\\文件.xlsx"] } })).state).toBe("partial");
  });

  it("未知总量使用不定进度，终态不再保留无效取消操作", () => {
    const { rerender } = render(
      <JobProgress job={makeJob({ total: 0 })} onCancel={() => undefined} />,
    );
    expect(screen.getByRole("progressbar").hasAttribute("value")).toBe(false);
    expect(screen.getByRole("button", { name: "取消任务" })).toBeTruthy();
    rerender(
      <JobProgress job={makeJob({ phase: "failed", message: "失败", severity: "error" })} onCancel={() => undefined} />,
    );
    expect(screen.queryByRole("button", { name: "取消任务" })).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("长结果仅展示前 20 条并保留完整路径提示", () => {
    const path = `C:\\${"超长目录\\".repeat(20)}结果文件.xlsx`;
    render(<ResultView value={{ warnings: Array.from({ length: 27 }, (_, i) => `${i}-${path}`), outputPaths: [path] }} />);
    expect(screen.getByText("另有 7 项未显示。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "结果文件.xlsx" }).getAttribute("title")).toBe(path);
  });
});
