// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MeetingEvent } from "../types";
import { MeetingWatch } from "./MeetingWatch";

const mocks = vi.hoisted(() => ({
  listener: undefined as ((event: MeetingEvent) => void) | undefined,
  status: vi.fn(),
  getByLabel: vi.fn(async () => { throw new Error("小窗不可用"); }),
}));

vi.mock("../api", () => ({
  listenMeetingEvents: vi.fn(async (listener: (event: MeetingEvent) => void) => {
    mocks.listener = listener;
    return () => undefined;
  }),
  listenMeetingAskChoice: vi.fn(async () => () => undefined),
  meetingStatus: mocks.status,
  meetingRecordStart: vi.fn(), meetingRecordStop: vi.fn(), jobStart: vi.fn(),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: { getByLabel: mocks.getByLabel },
  getCurrentWebviewWindow: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(), requestPermission: vi.fn(), sendNotification: vi.fn(),
}));

beforeEach(() => {
  mocks.status.mockReset();
  mocks.getByLabel.mockClear();
  mocks.listener = undefined;
});
afterEach(cleanup);

it("订阅前已检测到会议时从快照补回询问，结束后关闭降级弹窗", async () => {
  mocks.status.mockResolvedValue({ watchEnabled: true, inCall: true, recording: false });
  render(<MeetingWatch />);
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
  await act(async () => mocks.listener?.({ type: "call_ended", at: "now" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});

it("快照返回前已收到结束事件时不弹出过期会议询问", async () => {
  let resolve!: (value: unknown) => void;
  mocks.status.mockReturnValue(new Promise((done) => { resolve = done; }));
  render(<MeetingWatch />);
  await waitFor(() => expect(mocks.status).toHaveBeenCalled());
  await act(async () => {
    mocks.listener?.({ type: "call_ended", at: "now" });
    resolve({ watchEnabled: true, inCall: true, recording: false });
  });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  // 结束事件只尝试关闭一次，不再尝试打开小窗。
  expect(mocks.getByLabel).toHaveBeenCalledTimes(1);
});

it("已有录音时不根据快照重复询问", async () => {
  mocks.status.mockResolvedValue({ watchEnabled: true, inCall: true, recording: true });
  render(<MeetingWatch />);
  await waitFor(() => expect(mocks.status).toHaveBeenCalled());
  expect(mocks.getByLabel).not.toHaveBeenCalled();
});

it("会议已结束后，小窗迟到的创建失败不再重开降级弹窗", async () => {
  let reject!: (reason: Error) => void;
  mocks.getByLabel.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  mocks.status.mockResolvedValue({ watchEnabled: true, inCall: false, recording: false });
  render(<MeetingWatch />);
  await waitFor(() => expect(mocks.status).toHaveBeenCalled());
  await act(async () => mocks.listener?.({ type: "call_started", at: "start" }));
  await act(async () => {
    mocks.listener?.({ type: "call_ended", at: "end" });
    reject(new Error("创建失败"));
  });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
