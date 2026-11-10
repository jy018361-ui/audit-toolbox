// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  return { close: vi.fn(), minimize: vi.fn(), toggleMaximize: vi.fn(), isMaximized: vi.fn().mockResolvedValue(false), onResized: vi.fn().mockResolvedValue(() => {}) };
});
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => native }));
import { WindowControls } from "./WindowControls";
afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

it("AudiPick 的 X 执行返回首页，不关闭原生主窗口", () => {
  const onReturnToToolbox = vi.fn();
  render(<WindowControls onReturnToToolbox={onReturnToToolbox} />);
  fireEvent.click(screen.getByRole("button", { name: "返回工具箱" }));
  expect(onReturnToToolbox).toHaveBeenCalledOnce();
  expect(native.close).not.toHaveBeenCalled();
});

it("其他页面保持关闭窗口和最小化、最大化行为", () => {
  render(<WindowControls />);
  fireEvent.click(screen.getByRole("button", { name: "最小化" }));
  fireEvent.click(screen.getByRole("button", { name: "最大化" }));
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  expect(native.minimize).toHaveBeenCalledOnce();
  expect(native.toggleMaximize).toHaveBeenCalledOnce();
  expect(native.close).toHaveBeenCalledOnce();
});
