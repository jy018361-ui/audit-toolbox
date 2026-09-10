// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
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
