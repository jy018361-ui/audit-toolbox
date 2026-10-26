// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render as renderUi, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { JobEvent, MeetingEvent } from "../types";
import { MeetingWatch } from "./MeetingWatch";
import { MeetingMinutesPage } from "../MeetingMinutesPage";

function render(ui: ReactElement) {
  return renderUi(<MemoryRouter>{ui}</MemoryRouter>);
}

const mocks = vi.hoisted(() => ({
  listener: undefined as ((event: MeetingEvent) => void) | undefined,
  jobListener: undefined as ((event: JobEvent) => void) | undefined,
  jobStart: vi.fn(async () => "job-1"),
  openOutput: vi.fn(async () => true),
  status: vi.fn(),
  getByLabel: vi.fn<() => Promise<{ emit: (name: string) => Promise<void>; show: () => Promise<void>; hide: () => Promise<void>; setFocus: () => Promise<void> } | null>>(async () => { throw new Error("小窗不可用"); }),
  choiceListener: undefined as ((accepted: boolean) => void) | undefined,
}));

vi.mock("../api", () => ({
  listenMeetingEvents: vi.fn(async (listener: (event: MeetingEvent) => void) => {
    mocks.listener = listener;
    return () => undefined;
  }),
  listenMeetingAskChoice: vi.fn(async (callback: (accepted: boolean) => void) => {
    mocks.choiceListener = callback;
    return () => undefined;
  }),
  listenJobEvents: vi.fn(async (listener: (event: JobEvent) => void) => {
    mocks.jobListener = listener;
    return () => undefined;
  }),
  meetingStatus: mocks.status,
  meetingRecordStart: vi.fn(), meetingRecordStop: vi.fn(), jobStart: mocks.jobStart,
  openOutput: mocks.openOutput,
  runningInDesktopApp: vi.fn(() => true),
  meetingSetResident: vi.fn(async () => undefined),
  meetingReadMinutes: vi.fn(async () => ({ minutesMarkdown: "# 读入正文" })),
  meetingHistoryList: vi.fn(async () => []),
  meetingHistoryGet: vi.fn(async () => ({})),
  meetingReadTranscript: vi.fn(async () => ""),
  jobCancel: vi.fn(), pickPath: vi.fn(),
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
  fireEvent.click(screen.getByRole("button", { name: "打开输出文件夹" }));
  expect(mocks.openOutput).toHaveBeenCalledWith("C:/data/纪要.md");
});

it("首次挂载从后台快照恢复纪要结果", async () => {
  mocks.status.mockResolvedValue({ watchEnabled: true, inCall: false, recording: false, latestJob: completed });
  render(<MeetingWatch />);
  expect(await screen.findByText("会议纪要已生成")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "打开输出文件夹" })).toBeInTheDocument();
});

it("完成双版本任务后查看链接定位工具内版本，仅一个文件夹入口", async () => {
  mocks.status.mockResolvedValue({ watchEnabled: true, inCall: false, recording: false,
    latestJob: { ...completed, result: { minutesPath: "C:/data/按内容.md", transcriptPath: "C:/data/转写.txt",
      minutesVersions: [
        { kind: "content", label: "按内容", minutesPath: "C:/data/按内容.md" },
        { kind: "timeline", label: "按时间", minutesPath: "C:/data/按时间.md" },
      ],
    } },
  });
  render(<MeetingWatch />);
  expect(await screen.findByRole("link", { name: "查看按内容版" })).toHaveAttribute("href", "/tools/meeting_minutes?version=content");
  expect(screen.getByRole("link", { name: "查看按时间版" })).toHaveAttribute("href", "/tools/meeting_minutes?version=timeline");
  expect(screen.getAllByRole("button", { name: "打开输出文件夹" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "打开输出文件夹" }));
  expect(mocks.openOutput).toHaveBeenCalledWith("C:/data/按内容.md");
  expect(mocks.openOutput).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: "打开转写稿" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("link", { name: "查看按时间版" }));
  expect(mocks.openOutput).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("会议纪要已生成")).not.toBeInTheDocument();
});

it("确认退会后立即显示保存录音，收尾完成才显示结果", async () => {
  mocks.status.mockResolvedValue({ watchEnabled: true, inCall: true, recording: true,
    recordingSummary: { startedAt: "2026-10-22T16:22:48+08:00", warnings: [] } });
  render(<MeetingWatch />);
  expect(await screen.findByText(/正在录制会议/)).toBeInTheDocument();
  await act(async () => mocks.listener?.({ type: "call_ended", at: "end" }));
  expect(screen.queryByText(/正在录制会议/)).not.toBeInTheDocument();
  expect(screen.getByText("会议已结束，正在保存录音…")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "停止并生成纪要" })).not.toBeInTheDocument();
  await act(async () => {
    mocks.listener?.({ type: "recording_auto_finished", at: "saved", summary: {
      audioPath: "C:/data/audio.wav", durationSec: 296, startedAt: "2026-10-22T16:22:48+08:00",
    } });
    mocks.jobListener?.(completed);
  });
  expect(screen.queryByText("会议已结束，正在保存录音…")).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "查看会议纪要" })).toBeInTheDocument();
  expect(mocks.jobStart).not.toHaveBeenCalled();
});

it("退会后收尾失败时退出保存状态并显示原因", async () => {
  mocks.status.mockResolvedValue({ watchEnabled: true, inCall: true, recording: true,
    recordingSummary: { startedAt: "2026-10-22T16:22:48+08:00", warnings: [] } });
  render(<MeetingWatch />);
  await screen.findByText(/正在录制会议/);
  await act(async () => mocks.listener?.({ type: "call_ended", at: "end" }));
  await act(async () => mocks.listener?.({ type: "recording_failed", at: "saved", message: "混音文件保存失败" }));
  expect(screen.queryByText("会议已结束，正在保存录音…")).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("混音文件保存失败");
});

it("通知不可用时仍显示后台失败原因；LLM 失败仍可打开转写稿", async () => {
  mocks.status.mockResolvedValue({ watchEnabled: true, inCall: false, recording: false });
  render(<MeetingWatch />);
  await waitFor(() => expect(mocks.status).toHaveBeenCalled());
  await act(async () => mocks.listener?.({ type: "recording_failed", at: "now", message: "纪要任务启动失败：无法读取设置" }));
  expect(screen.getByRole("alert")).toHaveTextContent("纪要任务启动失败：无法读取设置");
  await act(async () => mocks.jobListener?.({ ...completed, result: { transcriptPath: "C:/data/转写.txt", minutesError: "未启用统一 LLM 配置" } }));
  expect(screen.getByRole("alert")).toHaveTextContent("未启用统一 LLM 配置");
  expect(screen.queryByRole("link", { name: "查看会议纪要" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "打开输出文件夹" })).toBeInTheDocument();
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
  expect(screen.getByRole("link", { name: "查看会议纪要" })).toBeInTheDocument();
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

it("已保活的会议页从完成提示切换两版正文并聚焦结果，不打开目录", async () => {
  const dualJob = { ...completed, result: {
    minutesPath: "C:/data/按内容.md", transcriptPath: "C:/data/转写.txt",
    minutesVersions: [
      { kind: "content", label: "按内容", minutesPath: "C:/data/按内容.md", minutesMarkdown: "# 内容版标题\n\n按议题归纳。" },
      { kind: "timeline", label: "按时间", minutesPath: "C:/data/按时间.md", minutesMarkdown: "# 时间版标题\n\n按时间先后。" },
    ],
  } };
  mocks.status.mockResolvedValue({ watchEnabled: true, resident: false, logFound: true, inCall: false, recording: false, latestJob: dualJob });
  function Fixture() {
    const location = useLocation();
    return <><MeetingWatch /><section hidden={location.pathname !== "/tools/meeting_minutes"}>
      <MeetingMinutesPage tool={{ id: "meeting_minutes", route: "/tools/meeting_minutes", name: "会议纪要助手", description: "", version: "1", capabilities: [], migrationStatus: "preview" }} />
    </section></>;
  }
  render(<Fixture />);
  fireEvent.click(await screen.findByRole("link", { name: "查看按时间版" }));
  expect(await screen.findByRole("article")).toHaveTextContent("时间版标题");
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "会议结果" })));
  expect(screen.queryByRole("link", { name: "查看按内容版" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "按内容" }));
  expect(screen.getByRole("article")).toHaveTextContent("内容版标题");
  expect(mocks.openOutput).not.toHaveBeenCalled();
});

it("退会后立即再进会议，串行隐藏并复用小窗，不销毁 WebView", async () => {
  const window = { emit: vi.fn(async () => undefined), show: vi.fn(async () => undefined),
    hide: vi.fn(async () => undefined), setFocus: vi.fn(async () => undefined) };
  mocks.getByLabel.mockResolvedValue(window);
  mocks.status.mockResolvedValue({ watchEnabled: true, inCall: false, recording: false });
  render(<MeetingWatch />);
  await waitFor(() => expect(mocks.status).toHaveBeenCalled());
  await act(async () => mocks.listener?.({ type: "call_started", at: "first" }));
  await waitFor(() => expect(window.show).toHaveBeenCalledTimes(1));
  await act(async () => {
    mocks.listener?.({ type: "call_ended", at: "end" });
    mocks.listener?.({ type: "call_started", at: "second" });
  });
  await waitFor(() => expect(window.show).toHaveBeenCalledTimes(2));
  expect(window.hide).toHaveBeenCalledTimes(1);
  expect(window.emit).toHaveBeenCalledWith("meeting-ask-reset");
  expect(window.hide.mock.invocationCallOrder[0]).toBeLessThan(window.show.mock.invocationCallOrder[1]);
  await act(async () => mocks.choiceListener?.(false));
  await waitFor(() => expect(window.hide).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
