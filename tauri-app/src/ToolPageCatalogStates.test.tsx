// @vitest-environment jsdom
// 真机审计 P2-001 回归：工具页必须区分「目录加载中 / 确认不存在 / 加载失败」
// 三态，不允许加载态借用「工具不存在」的错误措辞。
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import App, { ToolPage } from "./App";
import type { ToolManifest } from "./types";
import catalogJson from "../public/tool-catalog.json";

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  appBootstrap: vi
    .fn()
    .mockResolvedValue({ appVersion: "test", engine: { available: true } }),
  toolCatalog: vi.fn().mockImplementation(async () => catalogJson),
  settingsGet: vi.fn().mockResolvedValue({ llm: {} }),
  settingsSet: vi.fn().mockResolvedValue({}),
  engineCall: vi.fn().mockResolvedValue({}),
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
// 正向用例只验证「目录/登记齐全时不再误报」，用轻量替身代替整块专用页。
vi.mock("./DepositInterestPage", async () => {
  const { createElement } = await import("react");
  return {
    DepositInterestPage: () => createElement("p", null, "专用页已渲染"),
  };
});

const tool = (id: string, name: string): ToolManifest => ({
  id,
  name,
  description: "",
  route: `/tools/${id}`,
  version: "test",
  capabilities: [],
  migrationStatus: "ready",
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

describe("ToolPage 目录三态（直接渲染）", () => {
  it("目录加载中：显示加载提示，不出现「工具不存在」", () => {
    render(
      <MemoryRouter initialEntries={["/tools/deposit_interest"]}>
        <ToolPage
          catalog={[]}
          catalogStatus="loading"
          toolId="deposit_interest"
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("正在加载工具目录…")).toBeVisible();
    expect(screen.queryByText("工具不存在")).not.toBeInTheDocument();
  });

  it("目录加载失败：显示失败标题与「重新加载」按钮", () => {
    render(
      <MemoryRouter initialEntries={["/tools/deposit_interest"]}>
        <ToolPage
          catalog={[]}
          catalogStatus="error"
          toolId="deposit_interest"
        />
      </MemoryRouter>,
    );
    expect(
      screen.getByRole("heading", { name: "工具目录加载失败" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "重新加载" })).toBeVisible();
    expect(screen.queryByText("工具不存在")).not.toBeInTheDocument();
  });

  it("目录加载完成但确实没有该工具：显示「工具不存在」并附返回工作台", () => {
    render(
      <MemoryRouter initialEntries={["/tools/no_such_tool"]}>
        <ToolPage catalog={[]} catalogStatus="ready" toolId="no_such_tool" />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: "工具不存在" })).toBeVisible();
    expect(screen.getByRole("link", { name: "返回工作台" })).toHaveAttribute(
      "href",
      "/",
    );
  });

  it("目录与登记都齐全：正常进入专用页，不再误报", async () => {
    render(
      <MemoryRouter initialEntries={["/tools/deposit_interest"]}>
        <ToolPage
          catalog={[tool("deposit_interest", "存款利息收入测算")]}
          catalogStatus="ready"
          toolId="deposit_interest"
        />
      </MemoryRouter>,
    );
    expect(await screen.findByText("专用页已渲染")).toBeVisible();
    expect(screen.queryByText("工具不存在")).not.toBeInTheDocument();
  });
});

describe("App 集成：目录状态传导到工具页", () => {
  it("目录加载完成后没有该工具：整页显示「工具不存在」", async () => {
    render(
      <MemoryRouter initialEntries={["/tools/not_a_tool"]}>
        <App />
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole("heading", { name: "工具不存在" }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "返回工作台" })).toBeVisible();
  });

  it("目录还在加载：停在启动加载态，不显示「工具不存在」", async () => {
    const api = await import("./api");
    vi.mocked(api.toolCatalog).mockImplementation(
      () => new Promise(() => undefined),
    );
    render(
      <MemoryRouter initialEntries={["/tools/deposit_interest"]}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByText("正在准备审计工具箱…")).toBeVisible();
    expect(screen.queryByText("工具不存在")).not.toBeInTheDocument();
  });

  it("目录加载失败：显示启动失败与「重新加载」，不冒充「工具不存在」", async () => {
    const api = await import("./api");
    vi.mocked(api.toolCatalog).mockRejectedValue(
      new Error("工具目录加载失败"),
    );
    render(
      <MemoryRouter initialEntries={["/tools/deposit_interest"]}>
        <App />
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole("heading", { name: "启动失败" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "重新加载" })).toBeVisible();
    expect(screen.queryByText("工具不存在")).not.toBeInTheDocument();
  });
});
