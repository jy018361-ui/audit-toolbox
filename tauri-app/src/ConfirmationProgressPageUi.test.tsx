// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ConfirmationProgressPage from "./ConfirmationProgressPage";
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
beforeEach(() => sessionStorage.clear());
afterEach(cleanup);
const tool: ToolManifest = {
  id: "confirmation_progress",
  name: "函证进度",
  description: "",
  route: "/tools/confirmation_progress",
  version: "test",
  capabilities: [],
  migrationStatus: "ready",
};
it("检查前显示真实准备状态和资料要求", () => {
  render(<ConfirmationProgressPage tool={tool} />);
  expect(screen.getByText("待检查数据")).toBeVisible();
  expect(screen.queryByText("已就绪")).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: "准备函证清单" })).toBeVisible();
  expect(screen.getByRole("button", { name: "检查数据" })).toBeDisabled();
});
