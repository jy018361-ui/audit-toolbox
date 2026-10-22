// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { JobEvent, MeetingEvent } from "../types";
import { MeetingWatch } from "./MeetingWatch";

const mocks = vi.hoisted(() => ({
  listener: undefined as ((event: MeetingEvent) => void) | undefined,
  jobListener: undefined as ((event: JobEvent) => void) | undefined,
  jobStart: vi.fn(async () => "job-1"),
  openOutput: vi.fn(async () => true),
  status: vi.fn(),
  getByLabel: vi.fn(async () => { throw new Error("小窗不可用"); }),
}));

vi.mock("../api", () => ({
  listenMeetingEvents: vi.fn(async (listener: (event: MeetingEvent) => void) => {
    mocks.listener = listener;
    return () => undefined;
  }),
  listenMeetingAskChoice: vi.fn(async () => () => undefined),
  listenJobEvents: vi.fn(async (listener: (event: JobEvent) => void) => {
    mocks.jobListener = listener;
    return () => undefined;
  }),
  meetingStatus: mocks.status,
  meetingRecordStart: vi.fn(), meetingRecordStop: vi.fn(), jobStart: mocks.jobStart,
  openOutput: mocks.openOutput,
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
  mocks.jobListener = undefined;
  mocks.jobStart.mockClear();
  mocks.openOutput.mockClear();
});

const completed: JobEvent = {
  jobId: "auto-meeting-1", toolId: "meeting_minutes", phase: "completed",
  current: 4, total: 4, message: "生成完成", severity: "success", outputPaths: [],
  result: { minutesPath: "C:/data/纪要.md", transcriptPath: "C:/data/转写.txt" },
};

it("自动停录事件仅展示状态，不在前端重复启动上传任务", async () => {
  mocks.status.mockResolvedValue({ watchEnabled: true, inCall: false, recording: false });
  render(<MeetingWatch />);
  await waitFor(() => expect(mocks.status).toHaveBeenCalled());
  await act(async () => {
    mocks.listener?.({ type: "recording_started", at: "now", summary: { startedAt: "2026-10-19T10:00:00+08:00" } });
  });
  expect(screen.getByText(/正在录制会议/)).toBeInTheDocument();
  await act(async () => {
    mocks.listener?.({ type: "call_ended", at: "end" });
    mocks.listener?.({ type: "recording_auto_finished", at: "end", summary: {
      audioPath: "C:/data/audio.wav", durationSec: 600, startedAt: "2026-10-19T10:00:00+08:00",
    } });
    mocks.jobListener?.(completed);
  });
  expect(screen.queryByText(/正在录制会议/)).not.toBeInTheDocument();
  expect(mocks.jobStart).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "打开会议纪要" }));
  expect(mocks.openOutput).toHaveBeenCalledWith("C:/data/纪要.md");
});

it("首次挂载从后台快照恢复纪要结果", async () => {
  mocks.status.mockResolvedValue({ watchEnabled: true, inCall: false, recording: false, latestJob: completed });
  render(<MeetingWatch />);
  expect(await screen.findByText("会议纪要已生成")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "打开转写稿" })).toBeInTheDocument();
});

it("通知不可用时仍显示后台失败原因；LLM 失败仍可打开转写稿", async () => {
  mocks.status.mockResolvedValue({ watchEnabled: true, inCall: false, recording: false });
  render(<MeetingWatch />);
  await waitFor(() => expect(mocks.status).toHaveBeenCalled());
  await act(async () => mocks.listener?.({ type: "recording_failed", at: "now", message: "纪要任务启动失败：无法读取设置" }));
  expect(screen.getByRole("alert")).toHaveTextContent("纪要任务启动失败：无法读取设置");
  await act(async () => mocks.jobListener?.({ ...completed, result: { transcriptPath: "C:/data/转写.txt", minutesError: "未启用统一 LLM 配置" } }));
  expect(screen.getByRole("alert")).toHaveTextContent("未启用统一 LLM 配置");
  expect(screen.queryByRole("button", { name: "打开会议纪要" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "打开转写稿" })).toBeInTheDocument();
});

it("转写任务失败时显示详细原因", async () => {
  mocks.status.mockResolvedValue({ watchEnabled: true, inCall: false, recording: false });
  render(<MeetingWatch />);
  await waitFor(() => expect(mocks.status).toHaveBeenCalled());
  await act(async () => mocks.jobListener?.({ ...completed, phase: "failed", message: "语音转写失败", result: { error: { code: "ASR_FAILED", userMessage: "密钥已失效", detail: "InvalidApiKey；请求编号：request-123", retryable: true, diagnosticId: "test" } } }));
  expect(screen.getByRole("alert")).toHaveTextContent("密钥已失效");
  expect(screen.getByRole("alert")).toHaveTextContent("InvalidApiKey；请求编号：request-123");
});

it("迟到的快照不会覆盖刚收到的后台错误", async () => {
  let resolve!: (value: unknown) => void;
  mocks.status.mockReturnValue(new Promise((done) => { resolve = done; }));
  render(<MeetingWatch />);
  await waitFor(() => expect(mocks.status).toHaveBeenCalled());
  await act(async () => {
    mocks.listener?.({ type: "recording_failed", at: "now", message: "录音文件无法封盘" });
    resolve({ watchEnabled: true, inCall: false, recording: false, processingError: null });
  });
  expect(screen.getByRole("alert")).toHaveTextContent("录音文件无法封盘");
});

it("快照返回前任务已完成时保留新结果", async () => {
  let resolve!: (value: unknown) => void;
  mocks.status.mockReturnValue(new Promise((done) => { resolve = done; }));
  render(<MeetingWatch />);
  await waitFor(() => expect(mocks.status).toHaveBeenCalled());
  await act(async () => {
    mocks.jobListener?.(completed);
    resolve({ watchEnabled: true, inCall: false, recording: false, latestJob: null });
  });
  expect(screen.getByRole("button", { name: "打开会议纪要" })).toBeInTheDocument();
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
