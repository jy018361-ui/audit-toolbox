// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const jobPause = vi.fn((_jobId: string, _paused: boolean) =>
  Promise.resolve(true),
);
const jobCancel = vi.fn((_jobId: string) => Promise.resolve(true));
vi.mock("@/api", () => ({
  jobPause: (jobId: string, paused: boolean) => jobPause(jobId, paused),
  jobCancel: (jobId: string) => jobCancel(jobId),
}));

import { JobDialogProvider, isJobRunning } from "./JobDialog";
import { JobProgress } from "./JobProgress";
import type { JobEvent } from "@/types";

function job(overrides: Partial<JobEvent> = {}): JobEvent {
  return {
    jobId: "job-1",
    toolId: "Excel_Merger",
    phase: "merge",
    current: 3,
    total: 10,
    message: "正在合并第 3 个文件",
    severity: "info",
    outputPaths: [],
    ...overrides,
  };
}

const nameOf = (toolId: string) =>
  toolId === "Excel_Merger" ? "Excel 批量合并" : toolId;

function renderDialog(jobs: JobEvent[]) {
  return render(
    <JobDialogProvider jobs={jobs} nameOf={nameOf}>
      <div>页面内容</div>
    </JobDialogProvider>,
  );
}

afterEach(() => {
  cleanup();
  jobPause.mockClear();
  jobCancel.mockClear();
});

describe("任务进度弹窗", () => {
  it("大文件总行数未知时显示不定进度，不能误报百分之百", () => {
    renderDialog([job({ current: 10000, total: 0, message: "已缓存 10000 行" })]);
    expect(screen.getByText("处理中")).toBeTruthy();
    expect(screen.queryByText("100%")).toBeNull();
    expect(screen.getByRole("progressbar").hasAttribute("value")).toBe(false);
  });
  it("结束态的三个 phase 不算运行中", () => {
    expect(isJobRunning(job())).toBe(true);
    expect(isJobRunning(job({ phase: "completed" }))).toBe(false);
    expect(isJobRunning(job({ phase: "failed" }))).toBe(false);
    expect(isJobRunning(job({ phase: "cancelled" }))).toBe(false);
  });

  it("有任务在跑时弹出，显示工具名、进度与消息", () => {
    renderDialog([job()]);
    expect(screen.getByText("正在处理")).toBeTruthy();
    expect(screen.getByText("Excel 批量合并")).toBeTruthy();
    expect(screen.getByText("正在合并第 3 个文件")).toBeTruthy();
    expect(screen.getByText("30%")).toBeTruthy();
  });

  it("阶段计数走完但任务未完成时最多显示百分之九十九", () => {
    renderDialog([job({ current: 10, total: 10, message: "正在校验输出" })]);
    expect(screen.getByText("99%")).toBeTruthy();
    expect(screen.queryByText("100%")).toBeNull();
    expect(screen.getByRole("progressbar").getAttribute("value")).toBe("9.9");
  });

  it("任务全部结束后不再弹出", () => {
    renderDialog([job({ phase: "completed" })]);
    expect(screen.queryByText("正在处理")).toBeNull();
  });

  it("暂停按钮切换文案并把暂停状态传给后端，再点恢复", () => {
    renderDialog([job()]);
    fireEvent.click(screen.getByText("暂停"));
    expect(jobPause).toHaveBeenCalledWith("job-1", true);
    expect(screen.getByText("已暂停")).toBeTruthy();

    fireEvent.click(screen.getByText("继续"));
    expect(jobPause).toHaveBeenLastCalledWith("job-1", false);
    expect(screen.getByText("30%")).toBeTruthy();
  });

  it("内存自动暂停时显示等待状态并允许手动尝试继续", () => {
    renderDialog([
      job({
        phase: "memory_paused",
        message: "内存紧张，任务已自动暂停：当前可用 0.29 GiB。",
      }),
    ]);
    expect(screen.getByText("内存等待")).toBeTruthy();
    fireEvent.click(screen.getByText("尝试继续"));
    expect(jobPause).toHaveBeenCalledWith("job-1", false);
  });

  it("停止按钮取消任务", () => {
    renderDialog([job()]);
    fireEvent.click(screen.getByText("停止"));
    expect(jobCancel).toHaveBeenCalledWith("job-1");
  });

  it("最小化后收成右下角小条，点击可再展开", () => {
    renderDialog([job()]);
    fireEvent.click(screen.getByText("最小化"));
    expect(screen.queryByText("正在处理")).toBeNull();
    // 小条上仍报进度，任务没有被藏得无影无踪
    expect(screen.getByText("Excel 批量合并 · 点击展开")).toBeTruthy();
    expect(screen.getByText("30%")).toBeTruthy();

    fireEvent.click(screen.getByText("Excel 批量合并 · 点击展开"));
    expect(screen.getByText("正在处理")).toBeTruthy();
  });

  it("多个任务同时在跑时逐条列出", () => {
    renderDialog([job(), job({ jobId: "job-2", toolId: "fa_list" })]);
    expect(screen.getByText("正在处理 2 个任务")).toBeTruthy();
    expect(screen.getAllByText("暂停").length).toBe(2);
  });

  it("弹窗展示期间页面内联进度条让位，最小化后回来", () => {
    const running = job();
    render(
      <JobDialogProvider jobs={[running]} nameOf={nameOf}>
        <JobProgress job={running} cancelLabel="取消任务" />
      </JobDialogProvider>,
    );
    // 弹窗里那份仍在，页面内联的那份（带取消按钮）不重复渲染
    expect(screen.queryByText("取消任务")).toBeNull();

    fireEvent.click(screen.getByText("最小化"));
    expect(screen.getByText("正在合并第 3 个文件")).toBeTruthy();
  });
});
