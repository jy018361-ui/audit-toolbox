// @vitest-environment jsdom
// 运行失败的可见性回归：整体失败（如路径未授权）时，结果区必须显示失败原因，
// 不能停留在「尚未运行」占位——否则用户以为点了运行没反应（真实反馈于 2026-10）。
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    dataflowPreview: vi.fn(async () => {
      throw { code: "PATH_NOT_PERMITTED", userMessage: "路径未授权：C:\\凭证明细.csv", retryable: true };
    }),
  };
});

import { DataFlowPage } from "./DataFlowPage";
import type { ToolManifest } from "../types";

const dataflowTool: ToolManifest = {
  id: "dataflow",
  name: "数据流 DataFlow",
  description: "可视化数据处理工作流",
  route: "/tools/dataflow",
  version: "1.0",
  capabilities: ["preview", "run", "save", "open"],
  migrationStatus: "preview",
};

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

it("预览运行整体失败时，结果区显示「运行失败」与原因，而不是「尚未运行」", async () => {
  render(<DataFlowPage tool={dataflowTool} />);
  fireEvent.click(screen.getAllByText("输入")[0].closest("button") ?? screen.getAllByText("输入")[0]);
  const option = await screen.findByRole("menuitem", { name: /Excel 输入/ });
  fireEvent.click(option);
  fireEvent.click(screen.getByRole("button", { name: /预览运行/ }));

  const card = await screen.findByRole("alert");
  expect(card.textContent).toContain("运行失败");
  expect(card.textContent).toContain("路径未授权");
  expect(screen.queryByText(/尚未运行/)).not.toBeInTheDocument();
  // 状态栏同步显示失败。
  expect(screen.getByText(/运行失败/)).toBeInTheDocument();
});

it("空画布点预览运行，结果区显示「画布还没有节点」错误卡而非静默无反应", async () => {
  render(<DataFlowPage tool={dataflowTool} />);
  fireEvent.click(screen.getByRole("button", { name: /预览运行/ }));
  const card = await screen.findByRole("alert");
  expect(card.textContent).toContain("画布还没有节点");
  expect(screen.queryByText(/尚未运行/)).not.toBeInTheDocument();
});

it("未发生失败时，结果区仍显示「尚未运行」占位，不出现错误卡", async () => {
  render(<DataFlowPage tool={dataflowTool} />);
  fireEvent.click(screen.getAllByText("输入")[0].closest("button") ?? screen.getAllByText("输入")[0]);
  const option = await screen.findByRole("menuitem", { name: /Excel 输入/ });
  fireEvent.click(option);
  expect(await screen.findByText(/尚未运行/)).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
