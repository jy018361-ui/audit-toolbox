// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LoanInterestPage } from "./LoanInterestPage";
import type { ToolManifest } from "./types";

vi.mock("./api", () => ({
  engineCall: vi.fn(async () => []),
  jobCancel: vi.fn(),
  jobStart: vi.fn(),
  listenJobEvents: vi.fn(async () => () => undefined),
  listenPositionedFileDrops: vi.fn(async () => () => undefined),
  openOutput: vi.fn(),
  pickPath: vi.fn(async () => null),
}));
afterEach(cleanup);
const tool: ToolManifest = {
  id: "loan_interest",
  name: "借款利息测算",
  description: "",
  route: "/tools/loan_interest",
  version: "test",
  capabilities: [],
  migrationStatus: "ready",
};

it("按资料模式显示空态、联网边界和可访问的选中状态", () => {
  render(<LoanInterestPage tool={tool} />);
  expect(
    screen.getByRole("complementary", { name: "测算默认在本机完成" }),
  ).toHaveAttribute("data-mode", "network-assisted");
  expect(
    screen.getByRole("region", { name: "准备完整借款台账" }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "完整借款台账" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  fireEvent.click(screen.getByRole("button", { name: "TB＋JE" }));
  expect(screen.getByRole("button", { name: "TB＋JE" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByRole("region", { name: "准备 TB 与 JE" })).toBeVisible();
  expect(screen.getByText(/TB 与 JE 均需上传/)).toBeVisible();
  expect(
    screen.getByRole("button", {
      name: "一次选择 TB 与 JE（自动识别 Sheet）",
    }),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "下一步：利率确认" }),
  ).toBeDisabled();
});
