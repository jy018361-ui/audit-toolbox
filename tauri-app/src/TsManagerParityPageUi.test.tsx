// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TsManagerParityPage } from "./TsManagerParityPage";
import type { ToolManifest } from "./types";
vi.mock("./api", () => ({
  engineCall: vi.fn(),
  jobCancel: vi.fn(),
  jobStart: vi.fn(),
  openOutput: vi.fn(),
  pickPath: vi.fn(),
  listenJobEvents: vi.fn(async () => () => undefined),
  listenPositionedFileDrops: vi.fn(async () => () => undefined),
}));
afterEach(cleanup);
const tool: ToolManifest = {
  id: "ts_manager",
  name: "工时透视",
  description: "",
  route: "/tools/ts_manager",
  version: "test",
  capabilities: [],
  migrationStatus: "ready",
};
it("空文件状态不虚报就绪并显示资料指引", () => {
  render(<TsManagerParityPage tool={tool} />);
  expect(screen.getByText("待加载文件")).toBeVisible();
  expect(screen.queryByText("已就绪")).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: "准备工时数据" })).toBeVisible();
  expect(screen.getByRole("button", { name: "加载文件" })).toBeDisabled();
});
it("取消后页首独立显示状态和重试方向，不重复卡内进度", async () => {
  const { listenJobEvents } = await import("./api");
  const { container } = render(<TsManagerParityPage tool={tool} />);
  const callback = vi.mocked(listenJobEvents).mock.calls.at(-1)?.[0];
  act(() => callback?.({ toolId: "ts_manager", jobId: "cancel-test", phase: "cancelled", current: 1, total: 2, message: "任务已取消", severity: "info", outputPaths: [] }));
  expect(screen.getByText("已取消")).toHaveAttribute("data-variant", "warning");
  expect(container.querySelector('[data-variant="warning"]')?.closest('[role="status"]')).toHaveTextContent("可重新加载或导出");
  expect(container.querySelector('[data-job-state="cancelled"]')).toBeNull();
});
