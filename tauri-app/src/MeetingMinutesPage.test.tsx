// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render as renderUi, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  displayAudioFileName,
  MeetingMinutesPage,
} from "./MeetingMinutesPage";
import type { MeetingHistoryRow, ToolManifest } from "./types";

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
  meetingReadMinutes: vi.fn(async (path: string) => ({
    minutesPath: path, minutesMarkdown: "# 已有纪要标题\n\n原有纪要内容。",
  })),
  meetingHistoryList: vi.fn(async () => []),
  meetingHistoryGet: vi.fn(async () => ({})),
  meetingReadTranscript: vi.fn(async () => "[00:00] 原始发言。"),
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

function render(ui: ReactElement) {
  return renderUi(<MemoryRouter initialEntries={[tool.route]}>{ui}</MemoryRouter>);
}

beforeEach(async () => {
  const api = await import("./api");
  vi.mocked(api.meetingHistoryList).mockResolvedValue([]);
  vi.mocked(api.meetingHistoryGet).mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MeetingMinutesPage", () => {
  const savedRows: MeetingHistoryRow[] = [
    { id:"new", jobId:"new-job", title:"预算评审", startedAt:"2026-10-26T10:30:00+08:00", timeLabel:"生成时间", status:"completed", message:"已完成" },
    { id:"old", jobId:"old-job", title:"项目周报", startedAt:"2026-10-20T09:00:00+08:00", timeLabel:"导入时间", status:"completed", message:"已完成" },
  ];

  it("重开页面读取归档历史，按标题搜索并点击查看结果，不发起云端任务", async () => {
    const api = await import("./api");
    vi.mocked(api.meetingStatus).mockResolvedValue({watchEnabled:true,resident:false,inCall:false,logFound:true,recording:false});
    vi.mocked(api.meetingHistoryList).mockResolvedValue(savedRows);
    vi.mocked(api.meetingHistoryGet).mockImplementation(async (id) => ({title:id === "old" ? "项目周报" : "预算评审", minutesMarkdown:`# ${id}\n归档正文`, transcriptPath:`C:/data/${id}.txt`}));
    render(<MeetingMinutesPage tool={tool} />);
    expect(await screen.findByRole("article")).toHaveTextContent("new");
    fireEvent.change(screen.getByRole("searchbox", {name:"搜索会议标题"}), {target:{value:"周报"}});
    const list = screen.getByLabelText("会议历史列表");
    expect(within(list).queryByRole("button", {name:/预算评审/})).not.toBeInTheDocument();
    fireEvent.click(within(list).getByRole("button", {name:/项目周报/}));
    expect(await screen.findByRole("article")).toHaveTextContent("old");
    expect(api.meetingHistoryGet).toHaveBeenLastCalledWith("old");
    expect(api.jobStart).not.toHaveBeenCalled();
  });

  it("快速切换会议时丢弃迟到的上一场读取结果", async () => {
    const api = await import("./api");
    vi.mocked(api.meetingStatus).mockResolvedValue({watchEnabled:true,resident:false,inCall:false,logFound:true,recording:false});
    vi.mocked(api.meetingHistoryList).mockResolvedValue(savedRows);
    let resolveNew!: (value: {minutesMarkdown:string}) => void;
    vi.mocked(api.meetingHistoryGet).mockImplementation((id) => id === "new" ? new Promise((resolve) => {resolveNew = resolve;}) : Promise.resolve({minutesMarkdown:"# 已选择的旧会议"}));
    render(<MeetingMinutesPage tool={tool} />);
    await waitFor(() => expect(api.meetingHistoryGet).toHaveBeenCalledWith("new"));
    fireEvent.click(screen.getByRole("button", {name:/项目周报/}));
    expect(await screen.findByRole("article")).toHaveTextContent("已选择的旧会议");
    await act(async () => resolveNew({minutesMarkdown:"# 迟到的新会议"}));
    expect(screen.getByRole("article")).toHaveTextContent("已选择的旧会议");
    expect(screen.queryByText("迟到的新会议")).not.toBeInTheDocument();
  });

  it("阅读历史时后台任务的进度和完成事件不覆盖正文", async () => {
    const api = await import("./api");
    vi.mocked(api.meetingStatus).mockResolvedValue({watchEnabled:true,resident:false,inCall:false,logFound:true,recording:false});
    vi.mocked(api.meetingHistoryList).mockResolvedValue(savedRows);
    vi.mocked(api.meetingHistoryGet).mockResolvedValue({minutesMarkdown:"# 正在阅读的历史"});
    render(<MeetingMinutesPage tool={tool} />);
    await screen.findByRole("article");
    const listener = vi.mocked(api.listenJobEvents).mock.calls.at(-1)![0];
    await act(async () => {
      listener({jobId:"background",toolId:tool.id,phase:"running",current:1,total:4,message:"正在转写新会议",severity:"info",outputPaths:[]});
    });
    expect(screen.getByRole("article")).toHaveTextContent("正在阅读的历史");
    await act(async () => {
      listener({jobId:"background",toolId:tool.id,phase:"completed",current:4,total:4,message:"新会议已完成",severity:"success",outputPaths:[],result:{minutesMarkdown:"# 新会议正文"}});
    });
    expect(screen.getByRole("article")).toHaveTextContent("正在阅读的历史");
    expect(screen.queryByRole("heading", {name:"新会议正文"})).not.toBeInTheDocument();
  });

  it("原始转写按需加载纯文本且支持复制正文", async () => {
    const api = await import("./api");
    vi.mocked(api.meetingStatus).mockResolvedValue({watchEnabled:true,resident:false,inCall:false,logFound:true,recording:false});
    vi.mocked(api.meetingHistoryList).mockResolvedValue(savedRows);
    vi.mocked(api.meetingHistoryGet).mockResolvedValue({minutesMarkdown:"# 会议纪要", transcriptPath:"C:/data/raw.txt"});
    vi.mocked(api.meetingReadTranscript).mockResolvedValue("[00:00] <script>原始发言</script>");
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText}});
    render(<MeetingMinutesPage tool={tool} />);
    await screen.findByRole("article");
    expect(api.meetingReadTranscript).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", {name:"原始转写"}));
    expect(await screen.findByRole("article",{name:"原始转写正文"})).toHaveTextContent("<script>原始发言</script>");
    expect(document.querySelector("article script")).toBeNull();
    fireEvent.click(screen.getByRole("button",{name:"复制正文"}));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("[00:00] <script>原始发言</script>"));
  });

  it("一条历史读取失败后仍可选择其他会议", async () => {
    const api = await import("./api");
    vi.mocked(api.meetingStatus).mockResolvedValue({watchEnabled:true,resident:false,inCall:false,logFound:true,recording:false});
    vi.mocked(api.meetingHistoryList).mockResolvedValue(savedRows);
    vi.mocked(api.meetingHistoryGet).mockRejectedValueOnce(new Error("文件已被删除"))
      .mockResolvedValue({minutesMarkdown:"# 另一场会议"});
    render(<MeetingMinutesPage tool={tool} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("文件已被删除");
    fireEvent.click(screen.getByRole("button",{name:/项目周报/}));
    expect(await screen.findByRole("article")).toHaveTextContent("另一场会议");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("从历史重新生成时不会自动跳回旧会议，等待新任务结果", async () => {
    const api = await import("./api");
    vi.mocked(api.meetingStatus).mockResolvedValue({watchEnabled:true,resident:false,inCall:false,logFound:true,recording:false});
    vi.mocked(api.meetingHistoryList).mockResolvedValue(savedRows);
    vi.mocked(api.meetingHistoryGet).mockResolvedValue({minutesMarkdown:"# 旧会议正文",transcriptPath:"C:/data/old.txt"});
    render(<MeetingMinutesPage tool={tool} />);
    await screen.findByRole("article");
    fireEvent.click(screen.getByRole("button", {name:"从转写稿重新生成"}));
    await waitFor(() => expect(api.jobStart).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", {name:"手动开始记录"})).toBeDisabled());
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(api.meetingHistoryGet).toHaveBeenCalledTimes(1);
  });

  it("生成过程中打开已有纪要不会丢失运行任务或允许重复启动", async () => {
    const api = await import("./api");
    vi.mocked(api.meetingStatus).mockResolvedValue({watchEnabled:true,resident:false,inCall:false,logFound:true,recording:false});
    vi.mocked(api.pickPath).mockResolvedValueOnce("C:/data/local.md");
    render(<MeetingMinutesPage tool={tool} />);
    await waitFor(() => expect(api.listenJobEvents).toHaveBeenCalled());
    const listener = vi.mocked(api.listenJobEvents).mock.calls.at(-1)![0];
    await act(async () => listener({jobId:"live",toolId:tool.id,phase:"running",current:1,total:4,message:"正在转写",severity:"info",outputPaths:[]}));
    fireEvent.click(screen.getByRole("button",{name:"查看已有纪要"}));
    expect(await screen.findByRole("article")).toHaveTextContent("原有纪要内容。");
    expect(screen.getByRole("button",{name:"手动开始记录"})).toBeDisabled();
    expect(api.jobStart).not.toHaveBeenCalled();
  });

  it("合并配置与生成按钮，按配置、历史、结果排列且不再显示步骤条", async () => {
    render(<MeetingMinutesPage tool={tool} />);
    expect(
      screen.getByRole("heading", { level: 1, name: tool.name }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", {name:"会议记录配置"})).toBeInTheDocument();
    expect(screen.getByRole("heading", {name:"历史记录"})).toBeInTheDocument();
    expect(screen.getByRole("heading", {name:"会议结果"})).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "纪要详细度" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /会议标题|参会人/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", {name:"处理步骤"})).not.toBeInTheDocument();
    const config = screen.getByRole("region", {name:"会议记录配置"});
    expect(within(config).getByRole("combobox", {name:"纪要详细度"})).toBeInTheDocument();
    expect(within(config).getByRole("button", {name:"生成纪要"})).toBeInTheDocument();
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
      screen.getByRole("button", { name: "生成纪要" }),
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
    expect(await screen.findByRole("article", { name: "会议纪要正文" })).toHaveTextContent("原有纪要内容。");
    (await screen.findByRole("button", { name: "打开输出文件夹" })).click();
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

  it("完成事件直接渲染正文与待办表格，重新生成只提交详细度和转写路径", async () => {
    const { meetingStatus, listenJobEvents, jobStart, meetingReadMinutes } = await import("./api");
    vi.mocked(meetingStatus).mockResolvedValue({
      watchEnabled: true, resident: false, inCall: false, logFound: true, recording: false,
    });
    render(<MeetingMinutesPage tool={tool} />);
    await waitFor(() => expect(listenJobEvents).toHaveBeenCalled());
    const listener = vi.mocked(listenJobEvents).mock.calls.at(-1)?.[0];
    await act(async () => listener?.({
      jobId: "complete-job", toolId: tool.id, phase: "completed", current: 4, total: 4,
      message: "会议纪要已生成", severity: "success", outputPaths: [],
      result: { title: "健康课程", minutesPath: "C:/data/纪要.md", transcriptPath: "C:/data/转写.txt",
        minutesMarkdown: "# 健康课程\n\n## 四、后续事项\n\n| 类型 | 事项 | 责任人 | 截止时间 | 交付结果 |\n| --- | --- | --- | --- | --- |\n| 待办 | 复核材料 | 未提及 | 周三 | 清单 |\n| 待确认 | 确认复核负责人 | 未提及 | 未提及 | 未提及 |\n\n<script>alert(1)</script>\n\n![图片](https://example.com/private.png)\n\n[链接](https://example.com)",
      },
    }));
    const article = screen.getByRole("article", { name: "会议纪要正文" });
    expect(within(article).getByRole("heading", { name: "健康课程" })).toBeInTheDocument();
    expect(within(article).getByRole("cell", { name: "复核材料" })).toBeInTheDocument();
    expect(within(article).getByRole("columnheader", { name: "交付结果" })).toBeInTheDocument();
    expect(within(article).getByRole("heading", { name: "四、后续事项" })).toBeInTheDocument();
    expect(within(article).getByRole("cell", { name: /^待确认$/ })).toBeInTheDocument();
    expect(article.querySelector("script, img, a")).toBeNull();
    expect(meetingReadMinutes).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("combobox", { name: "纪要详细度" }), { target: { value: "detailed" } });
    fireEvent.click(screen.getByRole("button", { name: "从转写稿重新生成" }));
    await waitFor(() => expect(jobStart).toHaveBeenCalledWith("meeting.summarize", {
      transcriptPath: "C:/data/转写.txt", detailLevel: "detailed",
    }));
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });

  it("已有纪要可在界面本地查看，无需启动转写任务", async () => {
    const { meetingStatus, pickPath, meetingReadMinutes, jobStart } = await import("./api");
    vi.mocked(meetingStatus).mockResolvedValue({
      watchEnabled: true, resident: false, inCall: false, logFound: true, recording: false,
    });
    vi.mocked(pickPath).mockResolvedValueOnce("C:/data/已有纪要.md");
    render(<MeetingMinutesPage tool={tool} />);
    fireEvent.click(screen.getByRole("button", { name: "查看已有纪要" }));
    expect(await screen.findByRole("article", { name: "会议纪要正文" })).toHaveTextContent("原有纪要内容。");
    expect(meetingReadMinutes).toHaveBeenCalledWith("C:/data/已有纪要.md");
    expect(jobStart).not.toHaveBeenCalled();
  });

  it("旧结果正文读取失败时保留打开文件和重试生成入口", async () => {
    const { meetingStatus, meetingReadMinutes } = await import("./api");
    vi.mocked(meetingReadMinutes).mockRejectedValueOnce(new Error("文件已被移动"));
    vi.mocked(meetingStatus).mockResolvedValueOnce({
      watchEnabled: true, resident: false, inCall: false, logFound: true, recording: false,
      latestJob: {
        jobId: "old-job", toolId: tool.id, phase: "completed", current: 4, total: 4,
        message: "已完成", severity: "success", outputPaths: [],
        result: { minutesPath: "C:/data/旧纪要.md", transcriptPath: "C:/data/转写.txt" },
      },
    });
    render(<MeetingMinutesPage tool={tool} />);
    expect(await screen.findByText("文件已被移动")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开输出文件夹" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "从转写稿重新生成" })).toBeEnabled();
  });

  it("一次完成事件展示两个版本，切换正文与文件并一次重出两版", async () => {
    const { meetingStatus, listenJobEvents, openOutput, jobStart } = await import("./api");
    vi.mocked(meetingStatus).mockResolvedValue({
      watchEnabled: true, resident: false, inCall: false, logFound: true, recording: false,
    });
    render(<MeetingMinutesPage tool={tool} />);
    await waitFor(() => expect(listenJobEvents).toHaveBeenCalled());
    const listener = vi.mocked(listenJobEvents).mock.calls.at(-1)?.[0];
    await act(async () => listener?.({
      jobId: "dual-job", toolId: tool.id, phase: "completed", current: 1, total: 1,
      message: "已完成", severity: "success", outputPaths: [], result: {
        transcriptPath: "C:/data/转写.txt",
        minutesVersions: [
          { kind: "content", label: "按内容", minutesPath: "C:/data/按内容.md", minutesMarkdown: "# 按内容纪要\n\n合并同类议题。" },
          { kind: "timeline", label: "按时间", minutesPath: "C:/data/按时间.md", minutesMarkdown: "# 按时间纪要\n\n[00:08] 开场。\n\n[00:25] 调整方案。" },
        ],
      },
    }));
    expect(screen.getByRole("article")).toHaveTextContent("合并同类议题。");
    expect(screen.getByRole("button", { name: "按内容", pressed: true })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "打开输出文件夹" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "打开转写稿" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开输出文件夹" }));
    await waitFor(() => expect(openOutput).toHaveBeenCalledWith("C:/data/按内容.md"));
    fireEvent.click(screen.getByRole("button", { name: "按时间", pressed: false }));
    expect(screen.getByRole("article")).toHaveTextContent("[00:08] 开场。");
    expect(screen.getByRole("article")).not.toHaveTextContent("合并同类议题。");
    expect(openOutput).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("button", { name: "打开输出文件夹" })).toHaveLength(1);
    fireEvent.change(screen.getByRole("combobox", { name: "纪要详细度" }), { target: { value: "brief" } });
    fireEvent.click(screen.getByRole("button", { name: "从转写稿重新生成两个版本" }));
    await waitFor(() => expect(jobStart).toHaveBeenCalledWith("meeting.summarize", {
      transcriptPath: "C:/data/转写.txt", detailLevel: "brief",
    }));
    expect(jobStart).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("group", { name: "纪要版本" })).not.toBeInTheDocument();
  });

  it("快照恢复部分成功的两个版本，默认显示成功版并能查看失败原因", async () => {
    const { meetingStatus } = await import("./api");
    vi.mocked(meetingStatus).mockResolvedValueOnce({
      watchEnabled: true, resident: false, inCall: false, logFound: true, recording: false,
      latestJob: {
        jobId: "partial-dual", toolId: tool.id, phase: "completed", current: 1, total: 1,
        message: "已完成", severity: "success", outputPaths: [], result: {
          transcriptPath: "C:/data/转写.txt", minutesPath: "C:/data/按时间.md",
          minutesVersions: [
            { kind: "content", label: "按内容", minutesError: "按内容版服务超时" },
            { kind: "timeline", label: "按时间", minutesPath: "C:/data/按时间.md", minutesMarkdown: "# 按时间纪要\n\n成功版本内容。" },
          ],
        },
      },
    });
    render(<MeetingMinutesPage tool={tool} />);
    expect(await screen.findByRole("article")).toHaveTextContent("成功版本内容。");
    expect(screen.getByRole("button", { name: "按时间", pressed: true })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "按内容（未生成）" }));
    expect(screen.getByRole("alert")).toHaveTextContent("按内容版服务超时");
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /打开按.*版纪要/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "从转写稿重新生成两个版本" })).toBeEnabled();
  });

  it("新输入撤下两版正文，后台旧快照不会回填", async () => {
    const { meetingStatus, pickPath } = await import("./api");
    vi.mocked(meetingStatus).mockResolvedValue({
      watchEnabled: true, resident: false, inCall: false, logFound: true, recording: false,
      latestJob: { jobId: "old-dual", toolId: tool.id, phase: "completed", current: 1, total: 1,
        message: "已完成", severity: "success", outputPaths: [], result: {
          minutesVersions: [
            { kind: "content", label: "按内容", minutesMarkdown: "# 旧按内容\n正文" },
            { kind: "timeline", label: "按时间", minutesMarkdown: "# 旧按时间\n正文" },
          ],
        },
      },
    });
    render(<MeetingMinutesPage tool={tool} />);
    await screen.findByRole("group", { name: "纪要版本" });
    vi.mocked(pickPath).mockResolvedValueOnce("C:/data/新会议.wav");
    fireEvent.click(screen.getByRole("button", { name: /拖放或点击选择已有录音/ }));
    await waitFor(() => expect(screen.queryByRole("article")).not.toBeInTheDocument());
    expect(screen.queryByRole("group", { name: "纪要版本" })).not.toBeInTheDocument();
  });
});
