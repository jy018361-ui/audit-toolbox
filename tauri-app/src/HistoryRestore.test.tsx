// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { check } from "@tauri-apps/plugin-updater";
import App from "./App";
import { historyGet, historyRestore } from "./api";
import catalog from "../public/tool-catalog.json";

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  settingsGet: vi.fn().mockResolvedValue({ llm: {} }),
  settingsSet: vi.fn().mockResolvedValue({}),
  secretSet: vi.fn().mockResolvedValue(undefined),
  engineCall: vi.fn().mockResolvedValue({}),
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
vi.mock("./theme", () => ({ applyReadableForegrounds: vi.fn() }));

const wpTool = catalog.find((tool) => tool.id === "wp_service_generator")!;

const completedRow = (overrides: Record<string, unknown> = {}) => ({
  jobId: "job-wp-1",
  toolId: "wp_service_generator",
  status: "completed",
  message: "已生成服务单",
  outputPaths: ["C:\\out.xlsx"],
  startedAt: "2026-09-03T10:00:00+08:00",
  finishedAt: "2026-09-03T10:05:00+08:00",
  params: { folder: "C:\\客户A\\WP" },
  method: "wp.generate",
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(historyGet).mockResolvedValue([]);
  vi.mocked(check).mockResolvedValue(null);
});
afterEach(cleanup);

describe("history resume", () => {
  it("restores inputs and navigates to the tool page when clicking 继续任务", async () => {
    vi.mocked(historyGet).mockResolvedValue([completedRow()]);
    vi.mocked(historyRestore).mockResolvedValue({
      jobId: "job-wp-1",
      toolId: "wp_service_generator",
      params: { folder: "C:\\客户A\\WP" },
      missingPaths: [],
      authorizedPathCount: 1,
      method: "wp.generate",
    });
    render(
      <MemoryRouter initialEntries={["/history"]}>
        <App />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "继续任务" }));
    expect(vi.mocked(historyRestore)).toHaveBeenCalledWith("job-wp-1");
    // 跳到对应工具页（WP 服务单页能安全挂载），并出现全局恢复提示。
    expect(
      await screen.findByRole("heading", { name: wpTool.name }),
    ).toBeVisible();
    expect(
      screen.getByText("已恢复「FY27 WP服务单生成工具」上次任务的输入。"),
    ).toBeVisible();
  });

  it("warns about missing source files after restoring", async () => {
    vi.mocked(historyGet).mockResolvedValue([completedRow()]);
    vi.mocked(historyRestore).mockResolvedValue({
      jobId: "job-wp-1",
      toolId: "wp_service_generator",
      params: { folder: "C:\\客户A\\WP" },
      missingPaths: ["C:\\客户A\\WP"],
      authorizedPathCount: 0,
      method: "wp.generate",
    });
    render(
      <MemoryRouter initialEntries={["/history"]}>
        <App />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "继续任务" }));
    expect(
      await screen.findByText(/有 1 个原文件已不存在/),
    ).toBeVisible();
  });

  it("keeps rows without archived params action-free and surfaces restore errors", async () => {
    vi.mocked(historyGet).mockResolvedValue([
      completedRow({ jobId: "job-old", params: {} }),
    ]);
    const first = render(
      <MemoryRouter initialEntries={["/history"]}>
        <App />
      </MemoryRouter>,
    );
    await first.findByText("已生成服务单");
    expect(
      first.queryByRole("button", { name: "继续任务" }),
    ).not.toBeInTheDocument();
    first.unmount();

    // 新版本记录恢复失败时留在历史页，把后端的中文错误讲给用户。
    vi.mocked(historyGet).mockResolvedValue([completedRow()]);
    vi.mocked(historyRestore).mockRejectedValue({
      code: "HISTORY_NOT_FOUND",
      userMessage: "未找到该任务，无法恢复。",
      retryable: false,
      diagnosticId: "d1",
    });
    render(
      <MemoryRouter initialEntries={["/history"]}>
        <App />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "继续任务" }));
    expect(await screen.findByText("未找到该任务，无法恢复。")).toBeVisible();
  });

  it("hides the resume action for sub-step jobs like kanzhang.inspect", async () => {
    // 看账的「读取文件」子步骤也有参数存档，但只有文件路径没有字段映射，
    // 恢复它等于把现场覆盖成半成品——这类记录不显示按钮。
    vi.mocked(historyGet).mockResolvedValue([
      completedRow({
        jobId: "job-kz-read",
        toolId: "kanzhang",
        message: "已读取文件",
        params: { inputPath: "C:\\je.xlsx", headerRow: 1 },
        method: "kanzhang.inspect",
      }),
      completedRow({
        jobId: "job-kz-export",
        toolId: "kanzhang",
        message: "导出完成",
        params: {
          inputPath: "C:\\je.xlsx",
          mapping: { date: "日期" },
          targetBatches: [{ name: "批次1", accounts: ["管理费用"] }],
        },
        method: "kanzhang.export",
      }),
    ]);
    render(
      <MemoryRouter initialEntries={["/history"]}>
        <App />
      </MemoryRouter>,
    );
    await screen.findByText("已读取文件");
    expect(screen.getByText("导出完成")).toBeVisible();
    const buttons = screen.getAllByRole("button", { name: "继续任务" });
    expect(buttons).toHaveLength(1);
  });
});
