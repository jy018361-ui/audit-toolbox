// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MeetingEvent } from "./types";
import MeetingAskWindow from "./MeetingAskWindow";

const mocks = vi.hoisted(() => ({
  hide: vi.fn(async () => undefined),
  choice: vi.fn(async (_accepted: boolean) => undefined),
  start: vi.fn(async () => undefined),
  event: undefined as ((event: MeetingEvent) => void) | undefined,
  reset: undefined as (() => void) | undefined,
}));
vi.mock("./api", () => ({
  runningInDesktopApp: () => true,
  meetingAskChoice: mocks.choice,
  meetingRecordStart: mocks.start,
  listenMeetingEvents: vi.fn(async (callback: (event: MeetingEvent) => void) => {
    mocks.event = callback; return () => undefined;
  }),
  listenMeetingAskReset: vi.fn(async (callback: () => void) => {
    mocks.reset = callback; return () => undefined;
  }),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ hide: mocks.hide }),
}));
beforeEach(() => {
  mocks.hide.mockReset().mockResolvedValue(undefined);
  mocks.choice.mockReset().mockResolvedValue(undefined);
  mocks.start.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

it.each(["本次不记录", "关闭并选择本次不记录"])("%s：回传未结束仍立即隐藏询问窗", async (name) => {
  mocks.choice.mockImplementationOnce(() => new Promise(() => undefined));
  render(<MeetingAskWindow />);
  fireEvent.click(screen.getByRole("button", { name }));
  await waitFor(() => expect(mocks.hide).toHaveBeenCalledTimes(1));
  expect(mocks.choice).toHaveBeenCalledWith(false);
  expect(mocks.start).not.toHaveBeenCalled();
});

it("回传失败和 Escape 均不阻止隐藏", async () => {
  mocks.choice.mockRejectedValueOnce(new Error("事件回传失败"));
  render(<MeetingAskWindow />);
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(mocks.hide).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("退会自动隐藏，复用时清除旧错误，旧请求失败不污染新一场", async () => {
  let reject!: (error: Error) => void;
  mocks.start.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  render(<MeetingAskWindow />);
  await waitFor(() => expect(mocks.reset).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name: "开始记录" }));
  await act(async () => {
    mocks.event?.({ type: "call_ended", at: "end" });
    mocks.reset?.();
    reject(new Error("failed to acquire webview reference"));
  });
  expect(mocks.hide).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "开始记录" })).toBeEnabled();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("窗口引用错误显示中文且不妨碍关闭，下一次显示清除错误", async () => {
  mocks.start.mockRejectedValueOnce("failed to acquire webview reference");
  render(<MeetingAskWindow />);
  fireEvent.click(screen.getByRole("button", { name: "开始记录" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("会议询问窗口连接已失效");
  fireEvent.click(screen.getByRole("button", { name: "关闭并选择本次不记录" }));
  await waitFor(() => expect(mocks.hide).toHaveBeenCalledTimes(1));
  await act(async () => mocks.reset?.());
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
