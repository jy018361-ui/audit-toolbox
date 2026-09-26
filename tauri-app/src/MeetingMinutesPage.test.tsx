// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
    await waitFor(() =>
      expect(screen.getByText("自动检测已开启，正在等待会议开始。")).toBeInTheDocument(),
    );
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

  it("displayAudioFileName 只显示文件名", () => {
    expect(displayAudioFileName("C:\\data\\record-1\\audio-mix.wav")).toBe(
      "audio-mix.wav",
    );
    expect(displayAudioFileName("/home/me/meeting.mp3")).toBe("meeting.mp3");
    expect(displayAudioFileName("裸文件名.m4a")).toBe("裸文件名.m4a");
  });
});
