// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import App, { Settings } from "./App";
import {
  engineCall,
  historyGet,
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
  engineCall: vi.fn().mockResolvedValue({ bytes: 0, files: 0 }),
  appBootstrap: vi
    .fn()
    .mockResolvedValue({ appVersion: "test", engine: { available: true } }),
  toolCatalog: vi.fn().mockImplementation(async () => catalog),
  historyGet: vi.fn().mockResolvedValue([]),
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
vi.mock("./theme", () => ({ applyReadableForegrounds: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
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
afterEach(cleanup);

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

it("marks preview tools as trials in the sidebar without disabling them", async () => {
  render(
    <MemoryRouter initialEntries={["/"]}>
      <App />
    </MemoryRouter>,
  );
  await screen.findByRole("heading", { name: "今天要处理什么？" });
  const sidebar = within(
    document.querySelector("aside.sidebar")! as HTMLElement,
  );

  for (const name of ["AudiPick 智能合同审阅", "WP Roll Forward"]) {
    const link = sidebar.getByRole("link", {
      name: new RegExp(`${name}.*试用.*结果请复核`),
    });
    expect(link).toBeVisible();
    expect(link).toHaveAttribute("title", "试用功能，使用结果请复核。");
    expect(within(link).getByText("试用")).toBeVisible();
  }

  expect(
    sidebar.getByRole("link", { name: /汇兑损益测算/ }),
  ).not.toHaveAttribute("title");
});

it("groups settings, preserves draft across sections, and saves via the existing APIs", async () => {
  render(
    <Settings availableUpdate={null} onAvailableUpdateChange={() => {}} />,
  );
  await waitFor(() =>
    expect(screen.getByLabelText("模型")).toHaveValue("saved-model"),
  );
  expect(screen.getByRole("button", { name: "保存配置" })).toBeDisabled();
  expect(settingsGet).toHaveBeenCalled();
  expect(screen.getByRole("heading", { name: "统一 LLM 配置" })).toBeVisible();
  expect(
    screen.queryByRole("heading", { name: "软件更新" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByLabelText("百度 API Key")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("模型"), {
    target: { value: "draft-model" },
  });
  expect(screen.getByRole("button", { name: "保存配置" })).toBeEnabled();
  fireEvent.change(screen.getByLabelText("OCR 引擎"), {
    target: { value: "baidu" },
  });
  expect(screen.getByLabelText("百度 API Key")).toBeVisible();
  fireEvent.change(screen.getByLabelText("百度 API Key"), {
    target: { value: "test-placeholder" },
  });
  fireEvent.click(screen.getByRole("button", { name: /基本设置/ }));
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
  fireEvent.click(screen.getByRole("button", { name: /API 配置/ }));
  expect(screen.getByLabelText("模型")).toHaveValue("draft-model");
  fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
  await screen.findByRole("status");
  expect(settingsSet).toHaveBeenCalledWith(
    expect.objectContaining({
      llm: expect.objectContaining({ model: "draft-model" }),
      cache: { cleanup: "off" },
      ocr: { engine: "baidu" },
    }),
  );
  expect(secretSet).toHaveBeenCalledWith("baidu_ocr_key", "test-placeholder");
  expect(screen.getByLabelText("百度 API Key")).toHaveValue("");
  expect(screen.getByRole("button", { name: "保存配置" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: /基本设置/ }));
  expect(screen.getByRole("button", { name: "深绿" })).toBeVisible();
  expect(screen.getByRole("button", { name: "保存配置" })).toBeVisible();
  const updateButton = screen.getByRole("button", { name: "软件更新" });
  expect(updateButton.closest(".page-header-actions")).not.toBeNull();
  expect(document.querySelectorAll(".step-indicator button")).toHaveLength(2);
  fireEvent.click(updateButton);
  await waitFor(() =>
    expect(updateReleaseNotes).toHaveBeenCalledWith(undefined),
  );
  expect(screen.getByRole("button", { name: "重新检查" })).toBeVisible();
});

it("discloses telemetry fields and protects unsaved settings on leave", async () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  render(
    <MemoryRouter>
      <Settings availableUpdate={null} onAvailableUpdateChange={() => {}} />
    </MemoryRouter>,
  );
  await waitFor(() =>
    expect(screen.getByLabelText("模型")).toHaveValue("saved-model"),
  );
  fireEvent.click(screen.getByRole("button", { name: /基本设置/ }));
  expect(screen.getByLabelText("发送哪些使用信息")).toHaveAttribute(
    "data-mode",
    "telemetry",
  );
  expect(screen.getByText(/电脑名、系统用户名/)).toBeVisible();
  fireEvent.change(screen.getByRole("textbox", { name: /统计服务器地址/ }), {
    target: { value: "http://metrics.internal" },
  });
  expect(screen.getByText(/有未保存的配置修改/)).toBeVisible();

  const beforeUnload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(beforeUnload);
  expect(beforeUnload.defaultPrevented).toBe(true);

  const link = document.createElement("a");
  link.href = "#/history";
  link.textContent = "离开设置";
  document.body.appendChild(link);
  fireEvent.click(link);
  expect(confirm).toHaveBeenCalledWith(
    "设置尚未保存，确定离开并放弃这些修改吗？",
  );
  expect(window.location.hash).not.toBe("#/history");
  confirm.mockRestore();
});

it("requires confirmation before clearing local cache", async () => {
  vi.mocked(engineCall).mockResolvedValue({
    files: 1,
    bytes: 1024,
    oldestDays: 1,
    path: "C:\\cache",
  });
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  render(
    <MemoryRouter>
      <Settings availableUpdate={null} onAvailableUpdateChange={() => {}} />
    </MemoryRouter>,
  );
  await waitFor(() => expect(engineCall).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: /基本设置/ }));
  expect(screen.getByText("已缓存 1.0 KB")).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "立刻清理全部缓存（1.0 KB）" }),
  );
  expect(confirm).toHaveBeenCalledWith(
    "确定清理全部本机缓存吗？源文件和已生成文件不会被删除。",
  );
  expect(engineCall).toHaveBeenCalledTimes(1);
  confirm.mockRestore();
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
  expect(
    screen.queryByRole("button", { name: /确认更新到/ }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "收起" }));
  expect(screen.queryByText("本版更新内容")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "软件更新" }));
  await waitFor(() => expect(updateReleaseNotes).toHaveBeenCalledTimes(2));
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
