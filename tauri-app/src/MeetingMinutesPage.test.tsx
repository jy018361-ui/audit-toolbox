// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  displayAudioFileName,
  MeetingMinutesPage,
} from "./MeetingMinutesPage";
import type { ToolManifest } from "./types";

vi.mock("./api", () => ({
  jobCancel: vi.fn(async () => true),
  jobStart: vi.fn(async () => "job-1"),
  meetingRecordStart: vi.fn(async () => ({
    startedAt: "2026-09-26T10:00:00+08:00",
    recordDir: "C:/data/record-1",
    systemOk: true,
    micOk: true,
    warnings: [],
  })),
  meetingRecordStop: vi.fn(async () => ({
    audioPath: "C:/data/record-1/audio-mix.wav",
    recordDir: "C:/data/record-1",
    durationSec: 600,
    sizeBytes: 19200000,
    startedAt: "2026-09-26T10:00:00+08:00",
    warnings: [],
  })),
  meetingStatus: vi.fn(async () => ({
    watchEnabled: true,
    resident: false,
    inCall: false,
    logFound: true,
    recording: false,
  })),
  meetingSetResident: vi.fn(async () => undefined),
  openOutput: vi.fn(async () => true),
  pickPath: vi.fn(async () => null),
  listenJobEvents: vi.fn(async () => () => undefined),
  runningInDesktopApp: vi.fn(() => true),
}));
vi.mock("./toolPageActivity", () => ({
  markToolPageLive: vi.fn(),
}));

const tool: ToolManifest = {
  id: "meeting_minutes",
  name: "会议纪要助手",
  description: "",
  route: "/tools/meeting_minutes",
  version: "1.0",
  capabilities: [],
  migrationStatus: "preview",
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MeetingMinutesPage", () => {
  it("渲染页头与三个步骤卡片", async () => {
    render(<MeetingMinutesPage tool={tool} />);
    expect(
      screen.getByRole("heading", { level: 1, name: tool.name }),
    ).toBeInTheDocument();
    expect(screen.getByText("1. 会议记录")).toBeInTheDocument();
    expect(screen.getByText("2. 纪要选项")).toBeInTheDocument();
    expect(screen.getByText("3. 结果")).toBeInTheDocument();
    // 视觉审核 S8：步骤条第 2 步与正文卡片统一叫「纪要选项」。
    expect(
      screen.getByRole("button", { name: "2 纪要选项" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText("自动检测已开启，正在等待会议开始。")).toBeInTheDocument(),
    );
  });

  it("导入录音拖放框文案与实际交互一致（整框点击或拖入）", () => {
    render(<MeetingMinutesPage tool={tool} />);
    // 视觉审核 S8：不再指向不存在的「右侧浏览」按钮。
    expect(
      screen.getByText("拖放或点击选择已有录音（wav / mp3 / m4a 等）"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/点击右侧浏览/)).not.toBeInTheDocument();
  });

  it("检测关闭时给出设置指引", async () => {
    const { meetingStatus } = await import("./api");
    vi.mocked(meetingStatus).mockResolvedValueOnce({
      watchEnabled: false,
      resident: false,
      inCall: false,
      logFound: true,
      recording: false,
    });
    render(<MeetingMinutesPage tool={tool} />);
    await waitFor(() =>
      expect(
        screen.getByText("自动检测已在设置页关闭，可手动记录或导入录音。"),
      ).toBeInTheDocument(),
    );
  });

  it("未找到 Teams 日志时提示导入或手动记录", async () => {
    const { meetingStatus } = await import("./api");
    vi.mocked(meetingStatus).mockResolvedValueOnce({
      watchEnabled: true,
      resident: false,
      inCall: false,
      logFound: false,
      recording: false,
    });
    render(<MeetingMinutesPage tool={tool} />);
    await waitFor(() =>
      expect(screen.getByText(/未找到新版 Teams 日志/)).toBeInTheDocument(),
    );
  });

  it("打开后台常驻开关即调用 meetingSetResident", async () => {
    const { meetingSetResident } = await import("./api");
    render(<MeetingMinutesPage tool={tool} />);
    const toggle = await screen.findByRole("checkbox", { name: "后台常驻" });
    expect(toggle).not.toBeChecked();
    toggle.click();
    await waitFor(() => expect(meetingSetResident).toHaveBeenCalledWith(true));
    expect(
      await screen.findByText(/驻留系统托盘继续监控/),
    ).toBeInTheDocument();
  });

  it("停止录音后用混音文件启动 meeting.generate 任务", async () => {
    const { meetingStatus, meetingRecordStop, jobStart } = await import("./api");
    vi.mocked(meetingStatus).mockResolvedValue({
      watchEnabled: true,
      resident: false,
      inCall: false,
      logFound: true,
      recording: true,
    });
    render(<MeetingMinutesPage tool={tool} />);
    const stop = await screen.findByRole("button", {
      name: "停止并生成纪要",
    });
    stop.click();
    await waitFor(() => expect(meetingRecordStop).toHaveBeenCalled());
    await waitFor(() =>
      expect(jobStart).toHaveBeenCalledWith("meeting.generate", {
        audioPath: "C:/data/record-1/audio-mix.wav",
        detailLevel: "standard",
      }),
    );
  });

  it("浏览器预览模式：给出降级提示并禁用本机操作按钮", async () => {
    const { runningInDesktopApp } = await import("./api");
    vi.mocked(runningInDesktopApp).mockReturnValueOnce(false);
    render(<MeetingMinutesPage tool={tool} />);
    expect(
      screen.getByText(/浏览器中预览界面，Teams 检测、录音与生成纪要需在桌面应用中使用/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/浏览器预览模式：界面仅供查看/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "手动开始记录" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "从导入录音生成纪要" }),
    ).toBeDisabled();
  });

  it("转写启动后仍保留空录提醒", async () => {
    const { meetingStatus, meetingRecordStop, jobStart } = await import("./api");
    vi.mocked(meetingStatus).mockResolvedValue({
      watchEnabled: true, resident: false, inCall: true, logFound: true, recording: true,
    });
    vi.mocked(meetingRecordStop).mockResolvedValueOnce({
      audioPath: "C:/data/record-1/audio-mix.wav", recordDir: "C:/data/record-1",
      durationSec: 600, sizeBytes: 19200000, startedAt: "2026-09-26T10:00:00+08:00",
      warnings: ["录音里疑似没有录到人声"],
    });
    render(<MeetingMinutesPage tool={tool} />);
    (await screen.findByRole("button", { name: "停止并生成纪要" })).click();
    await waitFor(() => expect(jobStart).toHaveBeenCalled());
    expect(screen.getByText("录音里疑似没有录到人声")).toBeInTheDocument();
  });

  it("没有 SlimCore 日志时仍可通过音频会话等待会议", async () => {
    const { meetingStatus } = await import("./api");
    vi.mocked(meetingStatus).mockResolvedValueOnce({
      watchEnabled: true, resident: false, inCall: false, logFound: false,
      audioDetectionAvailable: true, recording: false,
    });
    render(<MeetingMinutesPage tool={tool} />);
    expect(await screen.findByText("自动检测已开启，正在等待会议开始。")).toBeInTheDocument();
    expect(screen.queryByText(/未找到新版 Teams 日志/)).not.toBeInTheDocument();
  });

  it("displayAudioFileName 只显示文件名", () => {
    expect(displayAudioFileName("C:\\data\\record-1\\audio-mix.wav")).toBe(
      "audio-mix.wav",
    );
    expect(displayAudioFileName("/home/me/meeting.mp3")).toBe("meeting.mp3");
    expect(displayAudioFileName("裸文件名.m4a")).toBe("裸文件名.m4a");
  });

  it("页面晚于自动任务打开时从后台快照显示结果", async () => {
    const { meetingStatus, openOutput } = await import("./api");
    vi.mocked(meetingStatus).mockResolvedValueOnce({
      watchEnabled: true, resident: true, inCall: false, logFound: true, recording: false,
      latestJob: {
        jobId: "auto-job", toolId: tool.id, phase: "completed", current: 4, total: 4,
        message: "会议纪要已生成", severity: "success", outputPaths: ["C:/data/纪要.md"],
        result: { title: "项目周会", minutesPath: "C:/data/纪要.md", transcriptPath: "C:/data/转写.txt" },
      },
    });
    render(<MeetingMinutesPage tool={tool} />);
    expect(await screen.findByText("项目周会")).toBeInTheDocument();
    (await screen.findByRole("button", { name: "打开会议纪要" })).click();
    await waitFor(() => expect(openOutput).toHaveBeenCalledWith("C:/data/纪要.md"));
  });

  it("后台自动任务未能启动时显示原因", async () => {
    const { meetingStatus } = await import("./api");
    vi.mocked(meetingStatus).mockResolvedValueOnce({
      watchEnabled: true, resident: true, inCall: false, logFound: true, recording: false,
      processingError: "纪要任务启动失败：无法读取配置",
    });
    render(<MeetingMinutesPage tool={tool} />);
    expect(await screen.findByText("纪要任务启动失败：无法读取配置")).toBeInTheDocument();
  });

  it("自动录音手动停止后，转写失败显示服务端详细原因和任务编号", async () => {
    const { meetingStatus, jobStart, listenJobEvents } = await import("./api");
    vi.mocked(meetingStatus).mockResolvedValue({
      watchEnabled: true, resident: false, inCall: true, logFound: true, recording: true,
    });
    render(<MeetingMinutesPage tool={tool} />);
    (await screen.findByRole("button", { name: "停止并生成纪要" })).click();
    await waitFor(() => expect(jobStart).toHaveBeenCalledWith("meeting.generate", expect.anything()));
    const listener = vi.mocked(listenJobEvents).mock.calls.at(-1)?.[0];
    expect(listener).toBeDefined();
    await act(async () => listener?.({
      jobId: "job-1", toolId: tool.id, phase: "failed", current: 1, total: 1,
      message: "百炼转写任务失败。", severity: "error", outputPaths: [],
      result: { error: { code: "ASR_TASK_FAILED", userMessage: "百炼转写任务失败。",
        detail: "InvalidFile.DownloadFailed；任务编号：task-123", retryable: true, diagnosticId: "test" } },
    }));
    expect(screen.getByRole("alert")).toHaveTextContent("InvalidFile.DownloadFailed");
    expect(screen.getByRole("alert")).toHaveTextContent("task-123");
  });

  it("重新打开页面从失败快照恢复详细原因", async () => {
    const { meetingStatus } = await import("./api");
    vi.mocked(meetingStatus).mockResolvedValueOnce({
      watchEnabled: true, resident: true, inCall: false, logFound: true, recording: false,
      latestJob: {
        jobId: "failed-job", toolId: tool.id, phase: "failed", current: 1, total: 1,
        message: "网络请求失败", severity: "error", outputPaths: [],
        result: { error: { code: "NETWORK_ERROR", userMessage: "网络请求失败",
          detail: "连接超时，任务编号：task-456", retryable: true, diagnosticId: "test" } },
      },
    });
    render(<MeetingMinutesPage tool={tool} />);
    expect(await screen.findByText(/连接超时，任务编号：task-456/)).toBeInTheDocument();
  });
});
