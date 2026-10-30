// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMemoryRouter, Link, MemoryRouter, RouterProvider } from "react-router-dom";
import { useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import App, { Field, Settings } from "./App";
import { ConfirmDialogHost } from "@/components/ConfirmDialog";
import {
  audipickOcrTest,
  engineCall,
  historyGet,
  historyRestore,
  meetingAsrTest,
  secretGet,
  settingsGet,
  settingsSet,
  secretSet,
  updateReleaseNotes,
} from "./api";
import catalog from "../public/tool-catalog.json";

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  settingsGet: vi.fn().mockResolvedValue({ llm: { model: "saved-model" } }),
  settingsSet: vi.fn().mockResolvedValue({}),
  secretSet: vi.fn().mockResolvedValue(undefined),
  secretGet: vi.fn().mockResolvedValue("saved-test-key"),
  meetingAsrTest: vi.fn().mockResolvedValue({ ok: true, message: "测试成功", elapsedMs: 10 }),
  audipickOcrTest: vi.fn().mockResolvedValue({ message: "OCR 连接及测试图片识别成功。", elapsedMs: 20 }),
  engineCall: vi.fn().mockResolvedValue({ bytes: 0, files: 0 }),
  appBootstrap: vi
    .fn()
    .mockResolvedValue({ appVersion: "test", engine: { available: true } }),
  toolCatalog: vi.fn().mockImplementation(async () => catalog),
  historyGet: vi.fn().mockResolvedValue([]),
  historyRestore: vi.fn(),
  listenJobEvents: vi.fn().mockResolvedValue(() => {}),
  updateReleaseNotes: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/plugin-updater", () => ({
  check: vi.fn().mockResolvedValue(null),
}));
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn().mockResolvedValue("test"),
}));
vi.mock("./theme", () => ({ setSavedTheme: vi.fn() }));
vi.mock("./AudiPickPage", () => ({
  AudiPickPage: () => (
    <section data-testid="audipick-main-window-page">
      AudiPick 主窗口页面
      <Link to="/tools/audipick">再次打开 AudiPick</Link>
      <Link to="/">返回工具箱</Link>
    </section>
  ),
}));
async function flushSettingsChanges() {
  fireEvent.blur(screen.getByRole("heading", { name: "设置" }));
  await waitFor(() => expect(document.querySelector(".settings-auto-status")).toHaveTextContent("已自动保存"));
}

it("autosaves text after typing pauses, applies selects, and removes help and save controls", async () => {
  render(<Settings availableUpdate={null} onAvailableUpdateChange={() => {}} />);
  await waitFor(() => expect(screen.getByLabelText("模型")).toHaveValue("saved-model"));
  expect(settingsSet).not.toHaveBeenCalled();
  expect(screen.queryByText("配置帮助")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", {name:"保存配置"})).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("模型"), {target:{value:"first"}});
  fireEvent.change(screen.getByLabelText("模型"), {target:{value:"latest-model"}});
  expect(settingsSet).not.toHaveBeenCalled();
  await waitFor(() => expect(settingsSet).toHaveBeenCalledWith(expect.objectContaining({llm:expect.objectContaining({model:"latest-model"})})));
  expect(settingsSet).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByLabelText("自动清理"), {target:{value:"off"}});
  await waitFor(() => expect(settingsSet).toHaveBeenLastCalledWith(expect.objectContaining({cache:expect.objectContaining({cleanup:"off"})})));
});

it("设置页在切换 OCR 和语音通道后仍保持精简文案", async () => {
  render(<Settings availableUpdate={null} onAvailableUpdateChange={() => {}} />);
  await waitFor(() => expect(screen.getByLabelText("模型")).toHaveValue("saved-model"));

  const expectConciseCopy = () => {
    expect(screen.queryByText(/仍需保存|先保存|测试不会自动保存/)).not.toBeInTheDocument();
    expect(screen.queryByText(/当前 URL：|OCR 与 AudiPick 共用|仅识别内置示例图片/)).not.toBeInTheDocument();
    expect(screen.queryByText(/缓存读过的科目余额表|按用途管理工具箱配置/)).not.toBeInTheDocument();
    expect(screen.queryByText(/字段复核可能耗时较长|会议录音会发送至|长会议可用/)).not.toBeInTheDocument();
    expect(screen.queryByText(/查看通道差异与计费方式|配置帮助|选择后立即生效/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存配置" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("API Key")).toHaveAttribute("placeholder", "留空表示不修改");
  };

  expectConciseCopy();
  for (const engine of ["bailian", "baidu", "local", "ai"]) {
    fireEvent.change(screen.getByLabelText("OCR 引擎"), { target: { value: engine } });
    expectConciseCopy();
    if (engine === "local") {
      expect(screen.queryByText("云端测试可能计费")).not.toBeInTheDocument();
    } else {
      expect(screen.getByText("云端测试可能计费")).toBeInTheDocument();
    }
  }
  expect(screen.getByText("旧数据迁移").closest("details")).not.toHaveAttribute("open");
  expect(screen.getByLabelText("迁移备份文件")).toBeInTheDocument();
  expect(screen.getByLabelText("开机自启")).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText("转写通道"), { target: { value: "token_plan" } });
  fireEvent.change(screen.getByLabelText("套餐转写模型"), { target: { value: "qwen-audio-3.0-asr-flash" } });
  expectConciseCopy();
  expect(screen.getByText("样音测试消耗少量套餐额度")).toBeInTheDocument();
  await flushSettingsChanges();
});

it("failed autosave keeps the current input and retries without a save button", async () => {
  vi.mocked(settingsSet).mockRejectedValueOnce({userMessage:"磁盘暂不可写"});
  render(<Settings availableUpdate={null} onAvailableUpdateChange={() => {}} />);
  await waitFor(() => expect(screen.getByLabelText("模型")).toHaveValue("saved-model"));
  fireEvent.change(screen.getByLabelText("模型"), {target:{value:"retry-model"}});
  fireEvent.blur(screen.getByLabelText("模型"));
  expect(await screen.findByRole("alert")).toHaveTextContent("自动保存失败：磁盘暂不可写");
  expect(screen.getByLabelText("模型")).toHaveValue("retry-model");
  expect(document.querySelector(".settings-auto-status")).not.toHaveTextContent("已自动保存");
  fireEvent.click(screen.getByRole("button", {name:"重试"}));
  await waitFor(() => expect(document.querySelector(".settings-auto-status")).toHaveTextContent("已自动保存"));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("does not overwrite settings before a failed initial read is retried", async () => {
  vi.mocked(settingsGet).mockRejectedValueOnce({userMessage:"配置读取异常"});
  render(<Settings availableUpdate={null} onAvailableUpdateChange={() => {}} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("配置读取失败：配置读取异常");
  expect(screen.getByLabelText("模型")).toBeDisabled();
  expect(settingsSet).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", {name:"重试"}));
  await waitFor(() => expect(screen.getByLabelText("模型")).toHaveValue("saved-model"));
  expect(screen.getByLabelText("模型")).toBeEnabled();
  expect(settingsSet).not.toHaveBeenCalled();
});

it("switching LLM providers saves typed credentials to their original provider only", async () => {
  render(<Settings availableUpdate={null} onAvailableUpdateChange={() => {}} />);
  await waitFor(() => expect(screen.getByLabelText("模型")).toHaveValue("saved-model"));
  fireEvent.change(screen.getByLabelText("API Key"), {target:{value:"openai-only"}});
  fireEvent.change(screen.getByLabelText("接口类型"), {target:{value:"dify_chat"}});
  await flushSettingsChanges();
  expect(secretSet).toHaveBeenCalledWith("llm_api_key", "openai-only");
  expect(secretSet).not.toHaveBeenCalledWith("dify_api_key", "openai-only");
  expect(screen.getByLabelText("API Key")).toHaveValue("");
});
let restoreCanvasMocks: () => void;
it("进入会议纪要时自动展开词库入口，仍可手动收起", async () => {
  render(<MemoryRouter initialEntries={["/tools/meeting_minutes"]}><App /></MemoryRouter>);
  const toggle = await screen.findByRole("button", { name: "会议纪要子菜单" });
  await waitFor(() => expect(toggle).toHaveAttribute("aria-expanded", "true"));
  expect(screen.getByRole("link", { name: /专有词库/ })).toBeVisible();
  fireEvent.click(toggle);
  expect(screen.queryByRole("link", { name: /专有词库/ })).not.toBeInTheDocument();
});

it("会议词库只在会议纪要二级菜单提供，独立路由可打开并返回", async () => {
  render(<MemoryRouter initialEntries={["/"]}><App /></MemoryRouter>);
  const toggle = await screen.findByRole("button", { name: "会议纪要子菜单" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("link", { name: /专有词库/ })).not.toBeInTheDocument();
  fireEvent.click(toggle);
  const link = screen.getByRole("link", { name: /专有词库/ });
  expect(link).toHaveAttribute("href", "/tools/meeting_minutes/vocabulary");
  fireEvent.click(link);
  expect(await screen.findByRole("heading", { name: "专有词库" })).toBeVisible();
  expect(screen.queryByRole("heading", { name: "会议记录配置" })).not.toBeInTheDocument();
  expect(link).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("link", { name: "返回会议纪要" })).toHaveAttribute("href", "/tools/meeting_minutes");
});

beforeEach(() => {
  vi.clearAllMocks();
  const context = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ fillRect: vi.fn(), fillText: vi.fn() } as unknown as CanvasRenderingContext2D);
  const dataUrl = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,dGVzdA==");
  restoreCanvasMocks = () => { context.mockRestore(); dataUrl.mockRestore(); };
  vi.stubGlobal("scrollTo", vi.fn());
  vi.mocked(historyGet).mockResolvedValue([]);
  vi.mocked(engineCall).mockResolvedValue({ bytes: 0, files: 0 });
  vi.mocked(check).mockResolvedValue(null);
  vi.mocked(updateReleaseNotes).mockResolvedValue({
    currentVersion: "1.0.0",
    targetVersion: "1.0.0",
    releases: [],
    commits: [],
    warnings: [],
  });
});
afterEach(async () => {
  cleanup();
  await act(async () => {});
  restoreCanvasMocks();
  vi.unstubAllGlobals();
});

it("uses continuous eight-digit entry for declarative date fields", () => {
  const onChange = vi.fn();
  render(
    <Field
      field={{ key: "bsDate", label: "资产负债表日", kind: "date", required: true }}
      value=""
      onChange={onChange}
    />,
  );

  const input = screen.getByLabelText(/^资产负债表日/);
  expect(input).toHaveAttribute("type", "text");
  fireEvent.change(input, { target: { value: "20261231" } });
  expect(input).toHaveValue("2026-12-31");
  expect(onChange).toHaveBeenLastCalledWith("2026-12-31");
});

it("presents one product identity and groups every catalog tool once", async () => {
  render(
    <MemoryRouter initialEntries={["/"]}>
      <App />
    </MemoryRouter>,
  );
  await screen.findByRole("heading", { name: "今天要处理什么？" });

  expect(screen.getByRole("heading", { name: "E点通工具箱" })).toBeVisible();
  expect(screen.queryByText("AUDIT TOOLKIT")).not.toBeInTheDocument();
  expect(screen.queryByText(/Rust 核心/)).not.toBeInTheDocument();
  expect(screen.getByLabelText("数据处理边界")).toHaveAttribute(
    "data-mode",
    "network-assisted",
  );
  for (const group of ["审计工具", "效率工具", "运营工具"]) {
    expect(screen.getByRole("heading", { name: group })).toBeVisible();
  }
  const dashboard = document.querySelector(".dashboard-tool-groups")!;
  expect(within(dashboard as HTMLElement).getAllByRole("link")).toHaveLength(
    catalog.length,
  );
  expect(document.querySelectorAll(".metrics .metric")).toHaveLength(3);
});

it("returns to the top when navigating away from a long settings page", async () => {
  const scrollTo = vi.fn();
  vi.stubGlobal("scrollTo", scrollTo);
  try {
    render(
      <MemoryRouter initialEntries={["/settings"]}>
        <App />
      </MemoryRouter>,
    );
    await screen.findByRole("heading", { name: "设置" });
    fireEvent.click(screen.getAllByRole("link", { name: "工作台" })[0]);
    await screen.findByRole("heading", { name: "今天要处理什么？" });
    expect(scrollTo).toHaveBeenCalledWith({ left: 0, top: 0, behavior: "instant" });
  } finally {
    vi.unstubAllGlobals();
  }
});

it("发现新版本时侧边栏「设置」显示圆点提示而非文字", async () => {
  vi.mocked(check).mockResolvedValue({ version: "9.9.9" } as Update);
  vi.useFakeTimers();
  try {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );
    // 自动检查更新在启动约 5 秒后触发，推进到那之后。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5500);
    });
    const sidebar = within(
      document.querySelector("aside.sidebar")! as HTMLElement,
    );
    const dot = sidebar.getByRole("status");
    expect(dot).toHaveAttribute("aria-label", "发现新版本 9.9.9");
    expect(dot).toHaveClass("nav-update-dot");
    // 圆点不带文字：视觉提示全部由 CSS 承担。
    expect(dot).toBeEmptyDOMElement();
  } finally {
    vi.useRealTimers();
  }
});

it("opens and closes the compact navigation drawer with keyboard and route changes", async () => {
  render(
    <MemoryRouter initialEntries={["/"]}>
      <App />
    </MemoryRouter>,
  );
  await screen.findByRole("heading", { name: "今天要处理什么？" });
  const trigger = screen.getByRole("button", { name: "打开工具导航" });
  fireEvent.click(trigger);
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  const close = within(
    document.querySelector("aside.sidebar")! as HTMLElement,
  ).getByRole("button", { name: "关闭工具导航" });
  expect(close).toHaveFocus();
  fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
  expect(
    document.querySelector("aside.sidebar")?.contains(document.activeElement),
  ).toBe(true);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(trigger).toHaveFocus();

  fireEvent.click(trigger);
  const sidebar = within(
    document.querySelector("aside.sidebar")! as HTMLElement,
  );
  fireEvent.click(sidebar.getByRole("link", { name: "历史记录" }));
  await screen.findByRole("heading", { name: "历史记录" });
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(trigger).toHaveFocus();
});

it.each(["completed", "success"])(
  "renders localized %s history metadata without exposing output paths",
  async (status) => {
    vi.mocked(historyGet).mockResolvedValue([
      {
        jobId: "job-1",
        toolId: "fx_audit",
        status,
        message: "底稿已生成",
        outputPaths: ["C:\\客户A\\result.xlsx"],
        startedAt: "2026-09-04T08:00:00+08:00",
        finishedAt: null,
        params: {},
        method: "fx.export",
      },
    ]);
    render(
      <MemoryRouter initialEntries={["/history"]}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByText("底稿已生成")).toBeVisible();
    expect(screen.getByText("已完成")).toBeVisible();
    expect(screen.getByText("输出 1 个文件")).toBeVisible();
    expect(screen.queryByText(/客户A/)).not.toBeInTheDocument();
  },
);

it("offers a useful action when history is empty", async () => {
  render(
    <MemoryRouter initialEntries={["/history"]}>
      <App />
    </MemoryRouter>,
  );
  expect(await screen.findByText("还没有任务记录")).toBeVisible();
  fireEvent.click(screen.getByRole("link", { name: "返回工作台" }));
  expect(
    await screen.findByRole("heading", { name: "今天要处理什么？" }),
  ).toBeVisible();
});

it("从 FA TB+JE 历史任务继续时重新读取完整源信息，不因缺失行数白屏", async () => {
  const params = {
    tbSource: { inputPath: "C:\\test\\tb.xlsx", sheet: "TB", headerRow: 1, headerDepth: 1 },
    jeSource: { inputPath: "C:\\test\\je.xlsx", sheet: "JE", headerRow: 1, headerDepth: 1 },
    tbMapping: { accountCode: "科目编码", openingFunctionalAmount: "期初", closingFunctionalAmount: "期末" },
    jeMapping: { accountCode: "科目编码", id: "凭证号", date: "日期", functionalAmount: "金额" },
    accountAssignments: [],
    reportEnd: "2026-12-31",
  };
  vi.mocked(historyGet).mockResolvedValue([{
    jobId: "fa-history",
    toolId: "fa_list",
    method: "fa.tbje_export",
    params,
    status: "completed",
    message: "已生成",
    outputPaths: [],
    startedAt: "2026-09-14T08:00:00+08:00",
    finishedAt: null,
  }]);
  vi.mocked(historyRestore).mockResolvedValue({
    jobId: "fa-history", toolId: "fa_list", params,
    missingPaths: [], authorizedPathCount: 2, method: "fa.tbje_export",
  });
  vi.mocked(engineCall).mockImplementation(async (method) => {
    if (method.startsWith("deposit.inspect_")) return {
      headers: ["科目编码", "金额"], sheet: method.endsWith("tb") ? "TB" : "JE",
      sheets: [method.endsWith("tb") ? "TB" : "JE"], headerRow: 1, headerDepth: 1,
      rowCount: 8, preview: [["1601", "100"]], entities: [], accounts: ["1601 固定资产"],
      suggestedMapping: {}, suggestedAccountRoles: {}, mappingCandidates: [],
      headerDetection: { needsConfirmation: false, candidates: [] }, dataYears: [2026],
    };
    return { bytes: 0, files: 0 };
  });
  render(<MemoryRouter initialEntries={["/history"]}><App /></MemoryRouter>);
  fireEvent.click(await screen.findByRole("button", { name: "继续任务" }));
  expect(
    await screen.findByRole(
      "heading",
      { name: "固定资产 TB＋JE 变动表" },
      { timeout: 5_000 },
    ),
  ).toBeVisible();
  expect(await screen.findByText("历史任务源文件已重新识别，请复核映射与科目分类后继续。")).toBeVisible();
  expect(screen.getAllByText("8 行")).toHaveLength(2);
  expect(engineCall).toHaveBeenCalledWith("deposit.inspect_tb", expect.objectContaining({
    source: expect.objectContaining({ inputPath: params.tbSource.inputPath }),
  }), "TB tb.xlsx");
  expect(engineCall).toHaveBeenCalledWith("deposit.inspect_je", expect.objectContaining({
    source: expect.objectContaining({ inputPath: params.jeSource.inputPath }),
  }), "JE je.xlsx");
});

it("FA TB+JE 源文件未变化时直接恢复识别快照", async () => {
  const params = {
    tbSource: { inputPath: "C:\\test\\tb.xlsx", sheet: "TB", headerRow: 1, headerDepth: 1 },
    jeSource: { inputPath: "C:\\test\\je.xlsx", sheet: "JE", headerRow: 1, headerDepth: 1 },
    tbMapping: { accountCode: "科目编码", openingFunctionalAmount: "期初", closingFunctionalAmount: "期末" },
    jeMapping: { accountCode: "科目编码", id: "凭证号", date: "日期", functionalAmount: "金额" },
    accountAssignments: [],
  };
  const inspection = (sheet: string) => ({
    headers: ["科目编码", "金额"], sheet, sheets: [sheet], headerRow: 1,
    headerDepth: 1, rowCount: 8, preview: [["1601", "100"]], entities: [],
    accounts: ["1601 固定资产"], suggestedMapping: {}, suggestedAccountRoles: {},
    mappingCandidates: [], headerDetection: { needsConfirmation: false, candidates: [] },
    dataYears: [2026],
  });
  vi.mocked(historyGet).mockResolvedValue([{
    jobId: "fa-snapshot", toolId: "fa_list", method: "fa.tbje_export", params,
    status: "completed", message: "已生成", outputPaths: [],
    startedAt: "2026-09-22T08:00:00+08:00", finishedAt: null,
  }]);
  vi.mocked(historyRestore).mockResolvedValue({
    jobId: "fa-snapshot", toolId: "fa_list", params,
    snapshotStatus: "valid",
    snapshot: { inspects: { tb: inspection("TB"), je: inspection("JE") } },
    missingPaths: [], authorizedPathCount: 2, method: "fa.tbje_export",
  });
  render(<MemoryRouter initialEntries={["/history"]}><App /></MemoryRouter>);
  fireEvent.click(await screen.findByRole("button", { name: "继续任务" }));
  expect(await screen.findByText("已从历史快照恢复 TB/JE 源信息，请复核映射与科目分类后继续。")).toBeVisible();
  expect(screen.getAllByText("8 行")).toHaveLength(2);
  expect(
    vi.mocked(engineCall).mock.calls.some(([method]) =>
      String(method).startsWith("deposit.inspect_"),
    ),
  ).toBe(false);
});

it.each(["/tasks", "/diagnostics"])(
  "removes obsolete navigation and redirects %s without losing the collapsible FA group",
  async (route) => {
    render(
      <MemoryRouter initialEntries={[route]}>
        <App />
      </MemoryRouter>,
    );
    await screen.findByRole("heading", { name: "今天要处理什么？" });
    const sidebar = within(
      document.querySelector("aside.sidebar")! as HTMLElement,
    );
    expect(sidebar.queryByText("任务中心")).not.toBeInTheDocument();
    expect(sidebar.queryByText("日志诊断")).not.toBeInTheDocument();
    const group = sidebar.getByRole("button", { name: /FA底稿生成/ });
    expect(group).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(group);
    expect(
      sidebar.queryByRole("link", { name: /折旧测算/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(group);
    expect(sidebar.getByRole("link", { name: /折旧测算/ })).toBeVisible();
    expect(sidebar.getByRole("link", { name: /借款利息测算/ })).toBeVisible();
    expect(sidebar.getByRole("link", { name: /PDF 转 Excel/ })).toBeVisible();
  },
);

it("marks upcoming tools in the sidebar and exposes Roll Forward as a ready download", async () => {
  render(
    <MemoryRouter initialEntries={["/"]}>
      <App />
    </MemoryRouter>,
  );
  await screen.findByRole("heading", { name: "今天要处理什么？" });
  const sidebar = within(
    document.querySelector("aside.sidebar")! as HTMLElement,
  );

  const audipick = sidebar.getByRole("link", {
    name: /AudiPick 智能合同审阅.*即将上线.*即将正式上线/,
  });
  expect(audipick).toBeVisible();
  expect(audipick).toHaveAttribute("title", "功能完善中，即将正式上线。");
  expect(within(audipick).getByText("即将上线")).toBeVisible();

  const rollForward = sidebar.getByRole("link", { name: /WP Roll Forward/ });
  expect(rollForward).toBeVisible();
  expect(rollForward).not.toHaveAttribute("title");
  fireEvent.click(rollForward);
  const downloadLink = await screen.findByRole("link", { name: "点击获取RollForward小工具" });
  expect(downloadLink).toHaveAttribute("href", expect.stringContaining("sharepoint.cn"));
  expect(screen.getByText("有疑问请联系Dana D Li")).toBeVisible();

  expect(
    sidebar.getByRole("link", { name: /汇兑损益测算/ }),
  ).not.toHaveAttribute("title");
});

it("opens AudiPick in focus mode without leaving clickable toolbox navigation underneath", async () => {
  render(
    <MemoryRouter initialEntries={["/"]}>
      <App />
    </MemoryRouter>,
  );
  await screen.findByRole("heading", { name: "今天要处理什么？" });
  const sidebar = within(
    document.querySelector("aside.sidebar")! as HTMLElement,
  );
  const link = sidebar.getByRole("link", {
    name: /AudiPick 智能合同审阅/,
  });
  expect(link).toHaveAttribute("href", "/tools/audipick");

  fireEvent.click(link);
  expect(await screen.findByTestId("audipick-main-window-page")).toBeVisible();
  expect(document.querySelector("aside.sidebar")).not.toBeInTheDocument();
  expect(screen.queryByRole("navigation", { name: "紧凑导航" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "打开工具导航" })).not.toBeInTheDocument();
  expect(document.querySelector(".sidebar-drawer-backdrop")).not.toBeInTheDocument();
  expect(document.querySelector(".app-shell")).toHaveClass("audipick-focus-mode");
  expect(document.querySelector(".app-shell")).toHaveAttribute(
    "data-layout-mode",
    "audipick-focus",
  );
  expect(document.querySelector("[data-tool-page='audipick']")).not.toHaveAttribute(
    "hidden",
  );

  fireEvent.click(screen.getByRole("link", { name: "再次打开 AudiPick" }));
  await waitFor(() =>
    expect(screen.getAllByTestId("audipick-main-window-page")).toHaveLength(1),
  );

  fireEvent.click(screen.getByRole("link", { name: "返回工具箱" }));
  await screen.findByRole("heading", { name: "今天要处理什么？" });
  expect(document.querySelector("aside.sidebar")).toBeVisible();
  expect(screen.getByRole("navigation", { name: "紧凑导航" })).toBeInTheDocument();
  expect(document.querySelector(".app-shell")).not.toHaveClass(
    "audipick-focus-mode",
  );
  expect(document.querySelector(".app-shell")).toHaveAttribute(
    "data-layout-mode",
    "toolbox",
  );
  const retainedAudiPickPage = document.querySelector(
    "[data-tool-page='audipick']",
  );
  expect(retainedAudiPickPage).toHaveAttribute("hidden");
  expect(retainedAudiPickPage).toHaveAttribute("inert");
  expect(screen.getAllByTestId("audipick-main-window-page")).toHaveLength(1);
});

it("桌面环境点击侧栏 AudiPick 仍在主窗口导航，不调用原生新窗口接口", async () => {
  localStorage.setItem("audit-toolbox.newbie-tour.v2", JSON.stringify({ newbieMode: false, workspaceDone: true }));
  render(<MemoryRouter initialEntries={["/"]}><App /></MemoryRouter>);
  await screen.findByRole("heading", {name:"今天要处理什么？"});
  const api = await import("./api");
  const meetingSnapshot = vi.spyOn(api,"meetingStatus");
  // 在工具箱挂载后开启桌面标记，精确覆盖原来只在 EXE 中触发的侧栏分支。
  const nativeInvoke = vi.fn(async () => undefined);
  vi.stubGlobal("__TAURI_INTERNALS__", {invoke:nativeInvoke});
  const alert = vi.spyOn(window,"alert").mockImplementation(() => undefined);
  try {
    const sidebar = within(document.querySelector("aside.sidebar")! as HTMLElement);
    fireEvent.click(sidebar.getByRole("link", {name:/AudiPick/}));
    expect(await screen.findByTestId("audipick-main-window-page")).toBeVisible();
    expect(document.querySelector(".app-shell")).toHaveClass("audipick-focus-mode");
    expect(nativeInvoke.mock.calls.some((args: unknown[]) => /(?:create_webview_window|get_all_webviews)/.test(String(args[0])))).toBe(false);
    expect(alert).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("link",{name:"返回工具箱"}));
    await screen.findByRole("heading",{name:"今天要处理什么？"});
    fireEvent.click(within(document.querySelector("aside.sidebar")! as HTMLElement).getByRole("link",{name:/AudiPick/}));
    expect(await screen.findByTestId("audipick-main-window-page")).toBeVisible();
    expect(screen.getAllByTestId("audipick-main-window-page")).toHaveLength(1);
    expect(meetingSnapshot).not.toHaveBeenCalled();
  } finally {
    meetingSnapshot.mockRestore();
    alert.mockRestore();
    localStorage.removeItem("audit-toolbox.newbie-tour.v2");
  }
});

it("redirects the legacy AudiPick window hash to the main-window tool route", async () => {
  render(
    <MemoryRouter initialEntries={["/audipick-window"]}>
      <App />
    </MemoryRouter>,
  );

  expect(await screen.findByTestId("audipick-main-window-page")).toBeVisible();
  expect(document.querySelector("aside.sidebar")).not.toBeInTheDocument();
  expect(screen.queryByRole("navigation", { name: "紧凑导航" })).not.toBeInTheDocument();
  expect(document.querySelector(".app-shell")).toHaveClass("audipick-focus-mode");
  expect(document.querySelector("[data-tool-page='audipick']")).not.toHaveAttribute(
    "hidden",
  );
});

it("groups settings into two columns on a single page, automatically applies changes via the existing APIs", async () => {
  render(
    <Settings availableUpdate={null} onAvailableUpdateChange={() => {}} />,
  );
  await waitFor(() =>
    expect(screen.getByLabelText("模型")).toHaveValue("saved-model"),
  );
  expect(screen.queryByRole("button", { name: "保存配置" })).not.toBeInTheDocument();
  expect(settingsGet).toHaveBeenCalled();
  expect(screen.getByLabelText(/^超时秒数/)).toHaveValue("120");
  expect(screen.getByRole("heading", { name: "统一 LLM 配置" })).toBeVisible();
  expect(
    screen.queryByRole("heading", { name: "软件更新" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByLabelText("百度 API Key")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("模型"), {
    target: { value: "draft-model" },
  });
  expect(screen.queryByRole("button", { name: "保存配置" })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("OCR 引擎"), {
    target: { value: "baidu" },
  });
  expect(screen.getByLabelText("百度 API Key")).toBeVisible();
  fireEvent.change(screen.getByLabelText("百度 API Key"), {
    target: { value: "test-placeholder" },
  });
  expect(screen.getByRole("heading", { name: "本地缓存" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "界面主题" })).toBeVisible();
  const themeButtons = screen
    .getAllByRole("button")
    .map((button) => button.textContent?.trim());
  expect(themeButtons.indexOf("清新黄绿")).toBeLessThan(
    themeButtons.indexOf("红黄米白"),
  );
  fireEvent.change(screen.getByLabelText("自动清理"), {
    target: { value: "off" },
  });
  expect(screen.getByLabelText("模型")).toHaveValue("draft-model");
  await flushSettingsChanges();
  expect(settingsSet).toHaveBeenCalledWith(
    expect.objectContaining({
      llm: expect.objectContaining({ model: "draft-model", timeout: 120 }),
      cache: { cleanup: "off" },
      ocr: expect.objectContaining({ engine: "baidu" }),
    }),
  );
  expect(secretSet).toHaveBeenCalledWith("baidu_ocr_key", "test-placeholder");
  expect(screen.getByLabelText("百度 API Key")).toHaveValue("test-placeholder");
  expect(screen.queryByRole("button", { name: "保存配置" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "深绿" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "保存配置" })).not.toBeInTheDocument();
  const updateButton = screen.getByRole("button", { name: "软件更新" });
  expect(updateButton.closest(".page-header-actions")).not.toBeNull();
  fireEvent.click(updateButton);
  await waitFor(() =>
    expect(updateReleaseNotes).toHaveBeenCalledWith(undefined),
  );
  expect(screen.getByRole("button", { name: "重新检查" })).toBeVisible();
});

it("超时留空自动保存为120秒，显式自定义值仍可保存", async () => {
  render(<Settings availableUpdate={null} onAvailableUpdateChange={() => {}} />);
  await waitFor(() => expect(screen.getByLabelText("模型")).toHaveValue("saved-model"));
  fireEvent.change(screen.getByLabelText(/^超时秒数/), { target: { value: "" } });
  await flushSettingsChanges();
  expect(settingsSet).toHaveBeenLastCalledWith(expect.objectContaining({ llm: expect.objectContaining({ timeout: 120 }) }));
  fireEvent.change(screen.getByLabelText(/^超时秒数/), { target: { value: "180" } });
  await flushSettingsChanges();
  expect(settingsSet).toHaveBeenLastCalledWith(expect.objectContaining({ llm: expect.objectContaining({ timeout: 180 }) }));
});

it("百炼 OCR 配置可修改、保存、重新加载，其他设置保存保留 OCR 参数", async () => {
  vi.mocked(settingsGet).mockResolvedValue({ llm: { model: "saved-model" }, ocr: { engine: "bailian", bailian_base_url: "https://saved.example/v1", bailian_model: "saved-ocr", custom: "keep" } });
  render(<MemoryRouter><Settings availableUpdate={null} onAvailableUpdateChange={() => {}} /></MemoryRouter>);
  await waitFor(() => expect(screen.getByLabelText("百炼 OCR URL")).toHaveValue("https://saved.example/v1"));
  expect(screen.getByLabelText("百炼 OCR 模型")).toHaveValue("saved-ocr");
  fireEvent.change(screen.getByLabelText("百炼 OCR URL"), { target: { value: "https://workspace.example/compatible-mode/v1" } });
  fireEvent.change(screen.getByLabelText("百炼 OCR 模型"), { target: { value: "qwen3.5-ocr" } });
  fireEvent.change(screen.getByLabelText("百炼 OCR API Key"), { target: { value: "bailian-placeholder" } });
  await flushSettingsChanges();
  expect(settingsSet).toHaveBeenCalledWith(expect.objectContaining({ ocr: { engine: "bailian", bailian_base_url: "https://workspace.example/compatible-mode/v1", bailian_model: "qwen3.5-ocr", custom: "keep" } }));
  expect(secretSet).toHaveBeenCalledWith("bailian_ocr_key", "bailian-placeholder");
  expect(screen.getByLabelText("百炼 OCR API Key")).toHaveValue("bailian-placeholder");
  cleanup();
  vi.mocked(settingsGet).mockResolvedValue({ llm: { model: "saved-model" } });
});

it("设置页测试前自动同步百炼 OCR 参数和密钥，并显示耗时", async () => {
  vi.mocked(settingsGet).mockResolvedValue({ llm: { model: "saved-model" }, ocr: { engine: "bailian" } });
  render(<MemoryRouter><Settings availableUpdate={null} onAvailableUpdateChange={() => {}} /></MemoryRouter>);
  await screen.findByLabelText("百炼 OCR URL");
  expect(screen.getByRole("button", { name: "测试 LLM 连接" })).toBeVisible();
  expect(audipickOcrTest).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("百炼 OCR URL"), { target: { value: " https://draft.example/compatible-mode/v1 " } });
  fireEvent.change(screen.getByLabelText("百炼 OCR 模型"), { target: { value: " draft-ocr " } });
  fireEvent.change(screen.getByLabelText("百炼 OCR API Key"), { target: { value: "ocr-draft-key" } });
  fireEvent.click(screen.getByRole("button", { name: "测试 OCR 连接" }));
  expect(await screen.findByRole("status")).toHaveTextContent("识别成功。 响应耗时 20 毫秒。");
  expect(audipickOcrTest).toHaveBeenLastCalledWith("bailian", "dGVzdA==", "ocr-draft-key", "", {
    bailian_base_url: "https://draft.example/compatible-mode/v1", bailian_model: "draft-ocr",
  }, true);
  expect(settingsSet).toHaveBeenCalled();
  expect(secretSet).toHaveBeenCalled();
  expect(screen.getByLabelText("百炼 OCR API Key")).toHaveValue("ocr-draft-key");
  fireEvent.change(screen.getByLabelText("百炼 OCR API Key"), { target: { value: "" } });
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "测试 OCR 连接" }));
  await screen.findByRole("status");
  expect(audipickOcrTest).toHaveBeenLastCalledWith("bailian", "dGVzdA==", "", "", expect.any(Object), true);
});

it.each(["baidu", "ai", "local"])("设置页 %s OCR 测试只传当前引擎的凭据", async (engine) => {
  vi.mocked(settingsGet).mockResolvedValue({ llm: { model: "saved-model" }, ocr: { engine: "bailian" } });
  render(<MemoryRouter><Settings availableUpdate={null} onAvailableUpdateChange={() => {}} /></MemoryRouter>);
  await screen.findByLabelText("百炼 OCR API Key");
  fireEvent.change(screen.getByLabelText("百炼 OCR API Key"), { target: { value: "unrelated-bailian-key" } });
  fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "unrelated-llm-key" } });
  fireEvent.change(screen.getByLabelText("OCR 引擎"), { target: { value: engine } });
  if (engine === "baidu") {
    fireEvent.change(screen.getByLabelText("百度 API Key"), { target: { value: "baidu-draft-key" } });
    fireEvent.change(screen.getByLabelText("百度 Secret Key"), { target: { value: "baidu-draft-secret" } });
  }
  fireEvent.click(screen.getByRole("button", { name: "测试 OCR 连接" }));
  await screen.findByRole("status");
  expect(audipickOcrTest).toHaveBeenLastCalledWith(engine, "dGVzdA==", engine === "baidu" ? "baidu-draft-key" : "", engine === "baidu" ? "baidu-draft-secret" : "", undefined, true);
  expect(settingsSet).toHaveBeenCalled();
  expect(secretSet).toHaveBeenCalled();
});

it("OCR 测试失败显示原因并可重试，修改配置清除旧结论", async () => {
  vi.mocked(settingsGet).mockResolvedValue({ llm: { model: "saved-model" }, ocr: { engine: "bailian" } });
  vi.mocked(audipickOcrTest).mockRejectedValueOnce({ userMessage: "OCR 鉴权失败，请核对密钥。" });
  render(<MemoryRouter><Settings availableUpdate={null} onAvailableUpdateChange={() => {}} /></MemoryRouter>);
  await screen.findByLabelText("百炼 OCR URL");
  fireEvent.click(screen.getByRole("button", { name: "测试 OCR 连接" }));
  expect(await screen.findByRole("status")).toHaveTextContent("OCR 鉴权失败，请核对密钥。");
  expect(screen.getByRole("status")).toHaveClass("failed");
  fireEvent.click(screen.getByRole("button", { name: "测试 OCR 连接" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveClass("success"));
  fireEvent.change(screen.getByLabelText("百炼 OCR 模型"), { target: { value: "new-model" } });
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it("OCR 测试期间防止重复点击，切换引擎后不显示迟到的旧成功结果", async () => {
  vi.mocked(settingsGet).mockResolvedValue({ llm: { model: "saved-model" }, ocr: { engine: "bailian" } });
  let finish!: (value: { message: string; elapsedMs: number }) => void;
  vi.mocked(audipickOcrTest).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  render(<MemoryRouter><Settings availableUpdate={null} onAvailableUpdateChange={() => {}} /></MemoryRouter>);
  await screen.findByLabelText("百炼 OCR URL");
  fireEvent.click(screen.getByRole("button", { name: "测试 OCR 连接" }));
  const button = screen.getByRole("button", { name: "正在测试 OCR…" });
  expect(button).toBeDisabled();
  fireEvent.click(button);
  await waitFor(() => expect(audipickOcrTest).toHaveBeenCalledTimes(1));
  fireEvent.change(screen.getByLabelText("OCR 引擎"), { target: { value: "local" } });
  await act(async () => { finish({ message: "旧请求成功", elapsedMs: 20 }); });
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "测试 OCR 连接" })).toBeEnabled();
});

it("leaving settings flushes text edits without a discard dialog", async () => {
  const view = render(<MemoryRouter><Settings availableUpdate={null} onAvailableUpdateChange={() => {}} /><ConfirmDialogHost /></MemoryRouter>);
  await waitFor(() => expect(screen.getByLabelText("模型")).toHaveValue("saved-model"));
  fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://llm.internal" } });
  view.unmount();
  await waitFor(() => expect(settingsSet).toHaveBeenCalledWith(expect.objectContaining({llm: expect.objectContaining({base_url:"https://llm.internal"})})));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("browser back applies changes without asking the user to save", async () => {
  const router = createMemoryRouter([
    {path:"/history",element:<p>历史页</p>},
    {path:"/settings",element:<Settings availableUpdate={null} onAvailableUpdateChange={() => {}} />},
  ], {initialEntries:["/history","/settings"],initialIndex:1});
  render(<><RouterProvider router={router} /><ConfirmDialogHost /></>);
  await waitFor(() => expect(screen.getByLabelText("模型")).toHaveValue("saved-model"));
  fireEvent.change(screen.getByLabelText("Base URL"), {target:{value:"https://llm.internal"}});
  await act(async () => {await router.navigate(-1);});
  expect(router.state.location.pathname).toBe("/history");
  await waitFor(() => expect(settingsSet).toHaveBeenCalledWith(expect.objectContaining({llm:expect.objectContaining({base_url:"https://llm.internal"})})));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("requires confirmation before clearing local cache", async () => {
  vi.mocked(engineCall).mockResolvedValue({
    files: 1,
    bytes: 1024,
    oldestDays: 1,
    path: "C:\\cache",
  });
  render(
    <MemoryRouter>
      <Settings availableUpdate={null} onAvailableUpdateChange={() => {}} />
      <ConfirmDialogHost />
    </MemoryRouter>,
  );
  expect(await screen.findByText("已缓存 1.0 KB")).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "立刻清理全部缓存（1.0 KB）" }),
  );
  expect(
    await screen.findByText(
      "确定清理全部本机缓存吗？源文件和已生成文件不会被删除。",
    ),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  await waitFor(() =>
    expect(
      screen.queryByText(
        "确定清理全部本机缓存吗？源文件和已生成文件不会被删除。",
      ),
    ).toBeNull(),
  );
  expect(engineCall).toHaveBeenCalledTimes(1);
});

function UpdateSettings({ initial = null }: { initial?: Update | null }) {
  const [available, setAvailable] = useState(initial);
  return (
    <Settings
      availableUpdate={available}
      onAvailableUpdateChange={setAvailable}
     
    />
  );
}

it("shows the full release range on every check and installs only after explicit confirmation", async () => {
  const downloadAndInstall = vi.fn().mockResolvedValue(undefined);
  const update = {
    version: "1.0.2",
    body: "latest only",
    downloadAndInstall,
  } as unknown as Update;
  vi.mocked(check).mockResolvedValue(update);
  vi.mocked(updateReleaseNotes).mockResolvedValue({
    currentVersion: "1.0.0",
    targetVersion: "1.0.2",
    commits: [],
    warnings: [],
    releases: [
      {
        version: "1.0.2",
        title: "新版",
        body: "修复导航",
        publishedAt: "2026-08-28T00:00:00Z",
      },
      {
        version: "1.0.1",
        title: "中间版",
        body: "<script>不执行发布说明中的脚本</script>",
        publishedAt: "",
      },
    ],
  });
  render(<UpdateSettings />);
  fireEvent.click(screen.getByRole("button", { name: "软件更新" }));
  await screen.findByText("修复导航");
  expect(screen.getByText("本次更新说明")).toBeVisible();
  expect(
    screen.getByText("<script>不执行发布说明中的脚本</script>"),
  ).toBeVisible();
  expect(document.querySelector(".settings-release-entry script")).toBeNull();
  expect(downloadAndInstall).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "重新检查" }));
  await waitFor(() => expect(updateReleaseNotes).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "确认更新到 v1.0.2" }),
    ).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "确认更新到 v1.0.2" }));
  await waitFor(() => expect(relaunch).toHaveBeenCalledOnce());
  expect(downloadAndInstall).toHaveBeenCalledOnce();
});

it("keeps notes failures distinct from update eligibility and labels the partial fallback", async () => {
  vi.mocked(check).mockResolvedValue({
    version: "1.0.1",
    body: "目标版本说明",
  } as Update);
  vi.mocked(updateReleaseNotes).mockRejectedValue({
    userMessage: "GitHub 请求受限",
  });
  render(<UpdateSettings />);
  fireEvent.click(screen.getByRole("button", { name: "软件更新" }));
  await screen.findByRole("alert");
  expect(screen.getByText(/GitHub 请求受限/)).toBeVisible();
  expect(
    screen.getByText("更新包附带说明（仅目标版本，非完整区间）"),
  ).toBeVisible();
  expect(screen.getByText("目标版本说明")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "确认更新到 v1.0.1" }),
  ).toBeEnabled();
});

it("shows this version's notes when up to date and refreshes on reopening", async () => {
  vi.mocked(updateReleaseNotes).mockResolvedValue({
    currentVersion: "1.0.0",
    targetVersion: "1.0.0",
    releases: [
      {
        version: "1.0.0",
        title: "本版",
        body: "本版更新内容",
        publishedAt: "",
      },
    ],
    warnings: [],
    commits: [],
  });
  render(<UpdateSettings />);
  fireEvent.click(screen.getByRole("button", { name: "软件更新" }));
  await screen.findByText("本版更新内容");
  expect(screen.getByText("已是最新")).toBeVisible();
  // 单版本说明不显示版本计数；版本号只保留标题区一处
  expect(screen.queryByText("1 个版本")).not.toBeInTheDocument();
  expect(
    screen.queryByText("当前版本：v1.0.0 · 来源：GitHub Releases"),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: /确认更新到/ }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "收起" }));
  expect(screen.queryByText("本版更新内容")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "软件更新" }));
  await waitFor(() => expect(updateReleaseNotes).toHaveBeenCalledTimes(2));
});

it("replaces all-empty release notes with the commit summary", async () => {
  vi.mocked(updateReleaseNotes).mockResolvedValue({
    currentVersion: "1.0.1",
    targetVersion: "1.0.1",
    releases: [
      { version: "1.0.1", title: "本版", body: "", publishedAt: "" },
    ],
    warnings: [],
    commits: ["fix(标题栏): 空白处可拖动", "feat(更新说明): 空说明用提交记录补齐"],
  });
  render(<UpdateSettings />);
  fireEvent.click(screen.getByRole("button", { name: "软件更新" }));
  await screen.findByText(/本版变更（相对上一版）/);
  expect(screen.getByText("fix(标题栏): 空白处可拖动")).toBeVisible();
  expect(screen.getByText("feat(更新说明): 空说明用提交记录补齐")).toBeVisible();
  // 精简后不重复叙述：无说明区标题行与版本计数、无状态条复述结论、无“未填写说明”解释
  expect(screen.queryByText(/本版说明/)).not.toBeInTheDocument();
  expect(screen.queryByText("1 个版本")).not.toBeInTheDocument();
  expect(
    screen.queryByText("当前没有可安装的新版本。以下展示本版发布说明（如有）。"),
  ).not.toBeInTheDocument();
  expect(screen.queryByText(/未填写更新说明/)).not.toBeInTheDocument();
});

it("does not offer a stale update when a fresh check fails", async () => {
  vi.mocked(check).mockRejectedValue(new Error("network"));
  render(<UpdateSettings initial={{ version: "1.0.1" } as Update} />);
  fireEvent.click(screen.getByRole("button", { name: "发现新版本 v1.0.1" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "重新检查" })).toBeEnabled(),
  );
  expect(
    screen.queryByRole("button", { name: /确认更新到/ }),
  ).not.toBeInTheDocument();
  expect(updateReleaseNotes).not.toHaveBeenCalled();
  expect(screen.getByText("未确认")).toBeVisible();
  expect(screen.queryByText("已是最新")).not.toBeInTheDocument();
  expect(screen.queryByText("可安装")).not.toBeInTheDocument();
});

it("disables duplicate checks and installation while release notes are loading", async () => {
  let finish!: (value: Awaited<ReturnType<typeof updateReleaseNotes>>) => void;
  vi.mocked(check).mockResolvedValue({ version: "1.0.1" } as Update);
  vi.mocked(updateReleaseNotes).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<UpdateSettings />);
  fireEvent.click(screen.getByRole("button", { name: "软件更新" }));
  await waitFor(() => expect(updateReleaseNotes).toHaveBeenCalledOnce());
  expect(screen.getByRole("button", { name: "检查中…" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "检查中…" }));
  expect(check).toHaveBeenCalledOnce();
  expect(
    screen.queryByRole("button", { name: /确认更新到/ }),
  ).not.toBeInTheDocument();
  finish({
    currentVersion: "1.0.0",
    targetVersion: "1.0.1",
    releases: [],
    commits: [],
    warnings: ["发布说明不完整"],
  });
  await screen.findByText("发布说明不完整");
  expect(
    screen.getByRole("button", { name: "确认更新到 v1.0.1" }),
  ).toBeEnabled();
});

it("语音转写通道可切换为 Token Plan 套餐通道并随保存落库", async () => {
  render(
    <MemoryRouter initialEntries={["/settings"]}>
      <App />
    </MemoryRouter>,
  );
  await screen.findByRole("heading", { name: "设置" });
  // 默认通用通道：只有通用密钥入口，没有套餐配置格子。
  expect(screen.getByLabelText("百炼 API 密钥")).toBeInTheDocument();
  expect(screen.queryByLabelText("套餐地址")).not.toBeInTheDocument();
  // 切到套餐通道：地址/模型/密钥三格出现，测试按钮换成套餐通道。
  fireEvent.change(screen.getByLabelText("转写通道"), {
    target: { value: "token_plan" },
  });
  expect(screen.getByLabelText("套餐地址")).toBeInTheDocument();
  expect(screen.getByLabelText("套餐转写模型")).toBeInTheDocument();
  expect(screen.getByLabelText(/^套餐 API 密钥/)).toBeInTheDocument();
  expect(screen.queryByLabelText("百炼 API 密钥")).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "测试套餐通道" }),
  ).toBeInTheDocument();
  // 保存后通道选择写入 meeting 命名空间，供转写任务读取。
  await flushSettingsChanges();
  await waitFor(() => expect(vi.mocked(settingsSet)).toHaveBeenCalled());
  const payload = vi.mocked(settingsSet).mock.calls[0][0] as {
    meeting: Record<string, unknown>;
  };
  expect(payload.meeting.asr_channel).toBe("token_plan");
  expect(payload.meeting.plan_model).toBe("qwen-audio-3.0-realtime-plus");
});

it("通用通道预填地址和模型，未保存的修改用于测试，切换通道后保留并保存", async () => {
  render(<MemoryRouter initialEntries={["/settings"]}><App /></MemoryRouter>);
  await screen.findByRole("heading", { name: "设置" });
  await waitFor(() => expect(screen.getByLabelText("模型")).toHaveValue("saved-model"));
  expect(screen.getByLabelText(/^通用服务地址/)).toHaveValue("https://dashscope.aliyuncs.com");
  expect(screen.getByLabelText(/^通用转写模型/)).toHaveValue("paraformer-v2");
  fireEvent.change(screen.getByLabelText(/^通用服务地址/), { target: { value: " https://asr.example.cn/gateway/ " } });
  fireEvent.change(screen.getByLabelText(/^通用转写模型/), { target: { value: " custom-file-model " } });
  fireEvent.change(screen.getByLabelText("百炼 API 密钥"), { target: { value: " general-test-key " } });
  fireEvent.click(screen.getByRole("button", { name: "测试百炼连接" }));
  await waitFor(() => expect(meetingAsrTest).toHaveBeenCalledWith(" general-test-key ", {
    channel: "paraformer", baseUrl: "https://asr.example.cn/gateway/", model: "custom-file-model",
  }));
  expect(settingsSet).toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("转写通道"), { target: { value: "token_plan" } });
  expect(screen.queryByLabelText(/^通用转写模型/)).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText(/^套餐 API 密钥/), { target: { value: "plan-test-key" } });
  fireEvent.click(screen.getByRole("button", { name: "测试套餐通道" }));
  await waitFor(() => expect(meetingAsrTest).toHaveBeenLastCalledWith("plan-test-key", {
    channel: "token_plan", baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com", model: "qwen-audio-3.0-realtime-plus",
  }));
  fireEvent.change(screen.getByLabelText("转写通道"), { target: { value: "paraformer" } });
  expect(screen.getByLabelText(/^通用转写模型/)).toHaveValue(" custom-file-model ");
  await flushSettingsChanges();
  await waitFor(() => expect(secretSet).toHaveBeenCalledWith("bailian_asr_key", " general-test-key "));
  expect(vi.mocked(settingsSet).mock.calls[0][0]).toMatchObject({ meeting: {
    asr_channel: "paraformer", asr_base_url: "https://asr.example.cn/gateway/", asr_model: "custom-file-model",
  } });
});

it("套餐 ASR Flash 使用当前草稿测试并说明内置样音与额度消耗", async () => {
  render(<MemoryRouter initialEntries={["/settings"]}><App /></MemoryRouter>);
  await screen.findByRole("heading", { name: "设置" });
  await waitFor(() => expect(screen.getByLabelText("模型")).toHaveValue("saved-model"));
  fireEvent.change(screen.getByLabelText("转写通道"), { target: { value: "token_plan" } });
  fireEvent.change(screen.getByLabelText("套餐地址"), { target: { value: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1" } });
  fireEvent.change(screen.getByLabelText("套餐转写模型"), { target: { value: " qwen-audio-3.0-asr-flash " } });
  fireEvent.change(screen.getByLabelText(/^套餐 API 密钥/), { target: { value: "test-only-key" } });
  expect(screen.getByText(/样音测试消耗少量套餐额度/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "测试套餐通道" }));
  await waitFor(() => expect(meetingAsrTest).toHaveBeenCalledWith("test-only-key", {
    channel: "token_plan",
    baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    model: "qwen-audio-3.0-asr-flash",
  }));
  expect(settingsSet).toHaveBeenCalled();
});

it("重新打开设置恢复通用通道的自定义配置", async () => {
  vi.mocked(settingsGet).mockResolvedValueOnce({ meeting: {
    asr_base_url: "https://saved-asr.example.cn", asr_model: "saved-file-model",
  } });
  render(<MemoryRouter><Settings availableUpdate={null} onAvailableUpdateChange={() => {}} /></MemoryRouter>);
  await waitFor(() => expect(screen.getByLabelText(/^通用服务地址/)).toHaveValue("https://saved-asr.example.cn"));
  expect(screen.getByLabelText(/^通用转写模型/)).toHaveValue("saved-file-model");
});

it("设置页可查看已保存密钥，查看不制造草稿也不覆盖已保存密钥", async () => {
  render(<MemoryRouter initialEntries={["/settings"]}><App /></MemoryRouter>);
  await screen.findByRole("heading", { name: "设置" });
  await waitFor(() => expect(screen.getByLabelText("模型")).toHaveValue("saved-model"));
  expect(secretGet).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "显示API Key" }));
  await waitFor(() => expect(screen.getByLabelText("API Key")).toHaveValue("saved-test-key"));
  expect(secretGet).toHaveBeenCalledWith("llm_api_key");
  expect(screen.getByLabelText("API Key")).toHaveAttribute("type", "text");
  expect(screen.queryByRole("button", { name: "保存配置" })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("模型"), { target: { value: "updated-model" } });
  await flushSettingsChanges();
  await waitFor(() => expect(document.querySelector(".settings-auto-status")).toHaveTextContent("已自动保存"));
  expect(secretSet).not.toHaveBeenCalled();
  expect(screen.getByLabelText("API Key")).toHaveValue("saved-test-key");
  fireEvent.click(screen.getByRole("button", { name: "隐藏API Key" }));
  expect(screen.getByLabelText("API Key")).toHaveAttribute("type", "password");
});
