// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useEffect, useState } from "react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import catalog from "../public/tool-catalog.json";
import { AudiPickLegacyShell } from "./AudiPickLegacyShell";
import App from "./App";

const pending = vi.hoisted(() => ({ finish: undefined as undefined | (() => void), unmount: vi.fn(), close: vi.fn() }));
vi.mock("./api", async original => ({
  ...await original<typeof import("./api")>(),
  settingsGet: vi.fn().mockResolvedValue({}),
  settingsSet: vi.fn().mockResolvedValue({}),
  appBootstrap: vi.fn().mockResolvedValue({ appVersion: "test", engine: { available: true } }),
  toolCatalog: vi.fn().mockImplementation(async () => catalog),
  historyGet: vi.fn().mockResolvedValue([]),
  listenJobEvents: vi.fn().mockResolvedValue(() => {}),
  telemetryTrack: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn().mockResolvedValue("test") }));
vi.mock("./components/WindowControls", () => ({
  WindowControls: ({ onReturnToToolbox }: { onReturnToToolbox?: () => void }) =>
    <button onClick={onReturnToToolbox ?? pending.close}>窗口 X</button>,
}));
vi.mock("./AudiPickPage", () => ({ AudiPickPage: function Preview() {
  const navigate = useNavigate();
  const [status, setStatus] = useState("未保存");
  useEffect(() => pending.unmount, []);
  return <AudiPickLegacyShell activePage="workbench" configReady logCount={0} logOpen={false} onNavigate={() => {}} onBackToToolbox={() => navigate("/")} onToggleLog={() => {}} logDrawer={null}>
    <p>{status}</p><button onClick={() => { setStatus("保存中"); pending.finish = () => setStatus("已保存"); }}>开始保存</button>
  </AudiPickLegacyShell>;
} }));
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.setItem("audit-toolbox.newbie-tour.v2", JSON.stringify({ newbieMode: false, workspaceDone: true }));
  vi.stubGlobal("scrollTo", vi.fn());
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

it.each(["/tools/audipick", "/audipick-window"])("%s 的 X 回首页并保留正在保存的 AudiPick", async path => {
  render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
  fireEvent.click(await screen.findByRole("button", { name: "开始保存" }));
  fireEvent.click(screen.getByRole("button", { name: "窗口 X" }));
  expect(await screen.findByRole("heading", { name: "今天要处理什么？" })).toBeVisible();
  expect(pending.close).not.toHaveBeenCalled();
  expect(pending.unmount).not.toHaveBeenCalled();
  act(() => pending.finish?.());
  fireEvent.click(within(document.querySelector("aside.sidebar") as HTMLElement).getByRole("link", { name: /AudiPick/ }));
  expect(await screen.findByText("已保存")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "返回工具箱" }));
  expect(await screen.findByRole("heading", { name: "今天要处理什么？" })).toBeVisible();
  expect(pending.close).not.toHaveBeenCalled();
  expect(pending.unmount).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "窗口 X" }));
  expect(pending.close).toHaveBeenCalledOnce();
});
