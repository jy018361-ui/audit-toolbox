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
import { settingsGet, settingsSet, secretSet, updateReleaseNotes } from "./api";
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

it.each(["/tasks", "/diagnostics"])(
  "removes obsolete navigation and redirects %s without losing the collapsible FA group",
  async (route) => {
    render(
      <MemoryRouter initialEntries={[route]}>
        <App />
      </MemoryRouter>,
    );
    await screen.findByRole("heading", { name: "选择一个工具开始处理" });
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

it("groups settings, preserves draft across sections, and saves via the existing APIs", async () => {
  render(
    <Settings availableUpdate={null} onAvailableUpdateChange={() => {}} />,
  );
  await waitFor(() =>
    expect(screen.getByLabelText("模型")).toHaveValue("saved-model"),
  );
  expect(settingsGet).toHaveBeenCalled();
  expect(screen.getByRole("heading", { name: "统一 LLM 配置" })).toBeVisible();
  expect(
    screen.queryByRole("heading", { name: "软件更新" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByLabelText("百度 API Key")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("模型"), {
    target: { value: "draft-model" },
  });
  fireEvent.change(screen.getByLabelText("OCR 引擎"), {
    target: { value: "baidu" },
  });
  expect(screen.getByLabelText("百度 API Key")).toBeVisible();
  fireEvent.change(screen.getByLabelText("百度 API Key"), {
    target: { value: "test-placeholder" },
  });
  fireEvent.click(screen.getByRole("button", { name: "2 基本设置" }));
  expect(screen.getByRole("heading", { name: "本地缓存" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "界面主题" })).toBeVisible();
  fireEvent.change(screen.getByLabelText("自动清理"), {
    target: { value: "off" },
  });
  fireEvent.click(screen.getByRole("button", { name: "1 API 配置" }));
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
  fireEvent.click(screen.getByRole("button", { name: "2 基本设置" }));
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
  expect(screen.getByText("更新范围：v1.0.0 → v1.0.2")).toBeVisible();
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
  fireEvent.click(screen.getByRole("button", { name: "软件更新 · v1.0.1" }));
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
