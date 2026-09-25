// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import catalog from "../public/tool-catalog.json";
import { JobProgress, jobStatusText, terminalJobError } from "./components/JobProgress";
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
  it("运行态计数已满时保留最后百分之一，完成后才显示百分之百", () => {
    expect(jobPresentation(makeJob({ phase: "write", current: 10, total: 10 }))).toMatchObject({
      percent: 99,
      terminal: false,
    });
    expect(jobPresentation(makeJob({ phase: "completed", current: 10, total: 10 }))).toMatchObject({
      percent: 100,
      terminal: true,
    });
  });

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

  it("状态词与进度消息同词时只渲染一次，不再出现“排队中 排队中”", () => {
    // 消息本身就是状态词（P2-2 的“处理中 处理中”来源）
    const same = render(<JobProgress job={makeJob({ message: "处理中" })} />);
    expect(screen.getAllByText("处理中")).toHaveLength(1);
    same.unmount();

    // 消息为空时状态词兜底一次
    const bare = render(<JobProgress job={makeJob({ message: "" })} />);
    expect(screen.getAllByText("处理中")).toHaveLength(1);
    bare.unmount();

    // 排队且总量未知：消息显示阶段文案，状态词只出现一次，也不再有百分比兜底成状态词
    const queued = render(
      <JobProgress
        job={makeJob({ phase: "queued", current: 0, total: 0, message: "排队读取凭证文件…" })}
        onCancel={() => undefined}
      />,
    );
    expect(screen.getByText("排队读取凭证文件…")).toBeTruthy();
    expect(screen.getAllByText("排队中")).toHaveLength(1);
    expect(screen.queryByText("排队中 排队中")).toBeNull();
    queued.unmount();

    // 消息与状态不同时各自保留：阶段文案 + 状态徽标 + 百分比
    const distinct = render(<JobProgress job={makeJob({ message: "正在合并第 3 个文件" })} />);
    expect(screen.getByText("正在合并第 3 个文件")).toBeTruthy();
    expect(screen.getByText("处理中")).toBeTruthy();
    expect(screen.getByText("20%")).toBeTruthy();
    distinct.unmount();
  });

  it("jobStatusText 与页内进度条同口径：胶囊格式为「状态 百分比」", () => {
    expect(jobStatusText(makeJob({ phase: "queued", current: 0, total: 100 }))).toBe("排队中 0%");
    expect(jobStatusText(makeJob({ phase: "merge", current: 3, total: 10 }))).toBe("处理中 30%");
    expect(jobStatusText(makeJob({ phase: "queued", current: 0, total: 0 }))).toBe("排队中");
    expect(jobStatusText(makeJob({ phase: "completed", current: 10, total: 10 }))).toBe("已完成 100%");
    expect(jobStatusText(makeJob({ phase: "failed", current: 4, total: 10, severity: "error" }))).toBe("处理失败 40%");
    expect(jobStatusText(makeJob({ phase: "cancelled", current: 4, total: 10 }))).toBe("已取消 40%");
    // 运行态最多 99%，与页内进度条口径一致
    expect(jobStatusText(makeJob({ phase: "write", current: 10, total: 10 }))).toBe("处理中 99%");
  });

  it("未知总量使用不定进度，终态不再保留无效取消操作", () => {
    const { rerender } = render(
      <JobProgress job={makeJob({ total: 0 })} onCancel={() => undefined} />,
    );
    expect(screen.getByRole("progressbar").hasAttribute("value")).toBe(false);
    expect(screen.getByRole("button", { name: "取消任务" })).toBeTruthy();
    rerender(
      <JobProgress
        job={makeJob({ total: Number.NaN })}
        onCancel={() => undefined}
      />,
    );
    expect(screen.getByRole("progressbar").getAttribute("max")).toBe("1");
    expect(screen.getByRole("progressbar").hasAttribute("value")).toBe(false);
    rerender(
      <JobProgress job={makeJob({ phase: "failed", message: "失败", severity: "error" })} onCancel={() => undefined} />,
    );
    expect(screen.queryByRole("button", { name: "取消任务" })).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("内联取消失败时保留操作入口并显示原因", async () => {
    const onCancel = () => Promise.resolve(false);
    render(<JobProgress job={makeJob()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "取消任务" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("取消指令未被接受"));
    expect(screen.getByRole("button", { name: "取消任务" })).toBeTruthy();
  });

  it("失败详情与任务状态合并展示，不重复进度消息", () => {
    const job = makeJob({ phase: "failed", message: "字段校验失败", severity: "error", result: { error: { userMessage: "请补齐科目编码" } } });
    expect(terminalJobError(job)).toBe("请补齐科目编码");
    render(<JobProgress job={job} detail={terminalJobError(job)} />);
    expect(screen.getByText("字段校验失败")).toBeTruthy();
    expect(screen.getByText("请补齐科目编码")).toBeTruthy();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("长结果仅展示前 20 条并保留完整路径提示", () => {
    const path = `C:\\${"超长目录\\".repeat(20)}结果文件.xlsx`;
    render(<ResultView value={{ warnings: Array.from({ length: 27 }, (_, i) => `${i}-${path}`), outputPaths: [path] }} />);
    expect(screen.getByText("另有 7 项未显示。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "结果文件.xlsx" }).getAttribute("title")).toBe(path);
  });
});
