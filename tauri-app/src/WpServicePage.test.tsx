// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WpServicePage } from "./WpServicePage";
import { listenJobEvents, pickPath } from "./api";
import type { JobEvent } from "./types";

vi.mock("./api", () => ({
  engineCall: vi.fn(),
  jobCancel: vi.fn(),
  jobStart: vi.fn(),
  listenJobEvents: vi.fn().mockResolvedValue(() => undefined),
  pickPath: vi.fn().mockResolvedValue(null),
}));

const tool = {
  id: "wp_service_generator",
  name: "WP 服务单",
  description: "",
  category: "底稿工具",
  enabled: true,
} as never;

function wpJobEvent(phase: string, overrides: Partial<JobEvent> = {}): JobEvent {
  return {
    jobId: "job-wp-1",
    toolId: "wp_service_generator",
    phase,
    current: 1,
    total: 1,
    message: "找不到我的订单文件，请检查目录内容。",
    severity: phase === "completed" ? "success" : "error",
    outputPaths: [],
    ...overrides,
  };
}

/** 选中工作目录（与真机操作一致），返回后目录槽显示已选文件。 */
async function renderWithFolder() {
  vi.mocked(pickPath).mockResolvedValueOnce("C:\\客户A\\WP");
  render(<WpServicePage tool={tool} />);
  fireEvent.click(
    screen.getByRole("button", { name: "拖放或单击选择目录" }),
  );
  await screen.findByRole("button", { name: /重新选择文件/ });
}

/** 派发一条 WP 服务单的 job 事件（与页面 listenJobEvents 注册的回调一致）。 */
function emitJobEvent(event: JobEvent) {
  const handler = vi.mocked(listenJobEvents).mock.calls.at(-1)?.[0];
  act(() => {
    handler?.(event);
  });
}

beforeEach(() => {
  vi.mocked(listenJobEvents).mockClear();
});
afterEach(cleanup);

describe("WpServicePage", () => {
  it("shows the directory drop target and keyword input requirements", () => {
    render(<WpServicePage tool={tool} />);

    expect(
      screen.getByRole("button", { name: "拖放或单击选择目录" }),
    ).toBeInTheDocument();
    expect(screen.getByText("目录内文件要求")).toBeInTheDocument();
    expect(screen.getByText(/文件名包含“WP服务单”/)).toBeInTheDocument();
    expect(screen.getByText(/文件名包含“section list”/)).toBeInTheDocument();
    expect(screen.getByText(/文件名包含“我的订单”/)).toBeInTheDocument();
    expect(screen.getByText(/每类输入文件只能保留一个/)).toBeInTheDocument();
    expect(screen.getByText("尚未生成结果")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1 选择目录" })).toHaveAttribute(
      "aria-current",
      "step",
    );
  });

  // P2-004：生成任务失败（如「找不到我的订单…」红色报错）时，
  // 第 2 步「检查输入」绝不能仍显示绿色已完成对勾。
  it("生成任务失败时第 2 步显示失败警示态而非已完成对勾", async () => {
    await renderWithFolder();

    emitJobEvent(wpJobEvent("failed"));

    // 目录已选 → 第 1 步保持已完成
    expect(
      screen.getByRole("button", { name: "1 选择目录（已完成）" }),
    ).toBeInTheDocument();
    // 第 2 步：失败态，既不是 done（无已完成对勾）也不是 active
    const step2 = screen.getByRole("button", { name: "2 检查输入（失败）" });
    expect(step2).toBeInTheDocument();
    expect(step2.className).toContain("error");
    expect(step2.className).not.toContain("done");
    expect(step2.className).not.toContain("active");
    expect(step2).not.toHaveAttribute("aria-current", "step");
    // 第 3 步不受影响，仍未开始
    expect(
      screen.getByRole("button", { name: "3 生成结果" }),
    ).not.toHaveAttribute("aria-current", "step");
    // 红色报错与步骤条状态一致（真机证据里两者矛盾）
    expect(screen.getByText(/找不到我的订单文件/)).toBeInTheDocument();
  });

  // 生成成功时的既有表现不得回退：第 2 步已完成、第 3 步成为当前步。
  it("生成任务成功时第 2 步仍显示已完成、第 3 步为当前步", async () => {
    await renderWithFolder();

    emitJobEvent(
      wpJobEvent("completed", {
        message: "已生成服务方案",
        outputPaths: ["C:\\out\\汇总.xlsx"],
      }),
    );

    expect(
      screen.getByRole("button", { name: "1 选择目录（已完成）" }),
    ).toBeInTheDocument();
    const step2 = screen.getByRole("button", { name: "2 检查输入（已完成）" });
    expect(step2.className).toContain("done");
    expect(step2.className).not.toContain("error");
    expect(
      screen.getByRole("button", { name: "3 生成结果" }),
    ).toHaveAttribute("aria-current", "step");
  });

  // 取消不算失败：第 2 步不打对勾也不标红，回退为当前步等待重试。
  it("生成任务取消时第 2 步不显示已完成也不标失败", async () => {
    await renderWithFolder();

    emitJobEvent(
      wpJobEvent("cancelled", { message: "任务已取消", severity: "info" }),
    );

    const step2 = screen.getByRole("button", { name: "2 检查输入" });
    expect(step2.className).not.toContain("done");
    expect(step2.className).not.toContain("error");
    // 回退到第 2 步为当前步，等待修正后重试
    expect(step2).toHaveAttribute("aria-current", "step");
    expect(screen.getByText("生成已取消")).toBeVisible();
    expect(screen.getByText(/本次生成已停止/)).toBeVisible();
    expect(screen.getByText("已取消")).toHaveAttribute("data-variant", "warning");
    expect(document.querySelector(".error-box")).toBeNull();
    expect(document.querySelector(".job-progress-error")).toBeNull();
  });
});
