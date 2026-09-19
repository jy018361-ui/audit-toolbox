// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import { MemoryRouter, NavLink, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { telemetryTrack } from "../api";
import {
  clearToolPageActivityForTests,
  toolPageIsLive,
} from "../toolPageActivity";
import {
  PersistentToolPages,
  retainedToolIds,
  toolIdFromPathname,
} from "./PersistentToolPages";

vi.mock("../api", () => ({ telemetryTrack: vi.fn() }));

afterEach(cleanup);

describe("PersistentToolPages", () => {
  beforeEach(() => {
    vi.mocked(telemetryTrack).mockClear();
    clearToolPageActivityForTests();
  });

  it("recognizes only complete tool routes", () => {
    expect(toolIdFromPathname("/tools/fx_audit")).toBe("fx_audit");
    expect(toolIdFromPathname("/tools/fx_audit/")).toBe("fx_audit");
    expect(toolIdFromPathname("/settings")).toBeUndefined();
    expect(toolIdFromPathname("/tools/a/more")).toBeUndefined();
  });

  it("reports a tool_open usage event whenever the active tool changes", async () => {
    render(
      <MemoryRouter initialEntries={["/tools/a"]}>
        <nav>
          <NavLink to="/tools/b">B</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <Routes>
          <Route path="/tools/:toolId" element={null} />
          <Route path="/settings" element={<p>settings</p>} />
        </Routes>
        <PersistentToolPages renderPage={() => <p>page</p>} />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(telemetryTrack).toHaveBeenCalledWith("tool_open", "a"),
    );
    fireEvent.click(screen.getByRole("link", { name: "B" }));
    await waitFor(() =>
      expect(telemetryTrack).toHaveBeenCalledWith("tool_open", "b"),
    );
    // 离开工具页（去设置页）不产生新的上报。
    fireEvent.click(screen.getByRole("link", { name: "Settings" }));
    expect(telemetryTrack).toHaveBeenCalledTimes(2);
  });

  it("keeps visited pages and their effects mounted while disabling hidden DOM", () => {
    const cleanup = vi.fn();
    function StatefulPage({ id }: { id: string }) {
      const [count, setCount] = useState(0);
      useEffect(() => cleanup, []);
      return (
        <button onClick={() => setCount((value) => value + 1)}>
          {id}:{count}
        </button>
      );
    }

    const view = render(
      <MemoryRouter initialEntries={["/tools/a"]}>
        <nav>
          <NavLink to="/tools/a">A</NavLink>
          <NavLink to="/tools/b">B</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <Routes>
          <Route path="/tools/:toolId" element={null} />
          <Route path="/settings" element={<p>settings</p>} />
        </Routes>
        <PersistentToolPages
          renderPage={(toolId) => <StatefulPage id={toolId} />}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "a:0" }));
    fireEvent.click(screen.getByRole("link", { name: "B" }));

    const pageA = view.container.querySelector<HTMLElement>(
      '[data-tool-page="a"]',
    );
    const pageB = view.container.querySelector<HTMLElement>(
      '[data-tool-page="b"]',
    );
    expect(pageA).toHaveAttribute("hidden");
    expect(pageA).toHaveAttribute("inert");
    expect(pageB).not.toHaveAttribute("hidden");
    expect(cleanup).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("link", { name: "A" }));
    expect(screen.getByRole("button", { name: "a:1" })).toBeVisible();

    fireEvent.click(screen.getByRole("link", { name: "Settings" }));
    expect(screen.getByText("settings")).toBeVisible();
    expect(pageA).toHaveAttribute("hidden");
    expect(pageB).toHaveAttribute("hidden");
    expect(cleanup).not.toHaveBeenCalled();

    view.unmount();
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it("caps blank hidden pages while live and running pages never count or evict", () => {
    const running = new Set(["a"]);
    // 运行中任务的 a 不占空白页名额：b、c 两个空白页在上限内，全部保留。
    expect(retainedToolIds(["a", "b", "c"], "d", running, 2)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    // 有现场的页同样不占名额：普通空白页仍被压到 2 个以内。
    expect(
      retainedToolIds(["a", "b", "c", "e", "f"], "d", new Set(), 2, new Set(["a", "b"])),
    ).toEqual(["a", "b", "e", "f", "d"]);
    // 离开工具页（activeToolId 为空）时依旧只清空白页。
    expect(retainedToolIds(["a", "c", "d", "e"], undefined, running, 2)).toEqual([
      "a",
      "d",
      "e",
    ]);
  });

  it("marks a tool page live on user interaction and keeps it mounted afterwards", async () => {
    const cleanupPage = vi.fn();
    function StatefulPage({ id }: { id: string }) {
      const [count, setCount] = useState(0);
      useEffect(() => cleanupPage, []);
      return (
        <button onClick={() => setCount((value) => value + 1)}>
          {id}:{count}
        </button>
      );
    }

    const view = render(
      <MemoryRouter initialEntries={["/tools/a"]}>
        <nav>
          <NavLink to="/tools/a">A</NavLink>
          <NavLink to="/tools/b">B</NavLink>
          <NavLink to="/tools/c">C</NavLink>
          <NavLink to="/tools/d">D</NavLink>
          <NavLink to="/tools/e">E</NavLink>
        </nav>
        <Routes>
          <Route path="/tools/:toolId" element={null} />
        </Routes>
        <PersistentToolPages renderPage={(toolId) => <StatefulPage id={toolId} />} />
      </MemoryRouter>,
    );

    // 在 a 页点一下 = 有现场。
    fireEvent.click(screen.getByRole("button", { name: "a:0" }));
    expect(toolPageIsLive("a")).toBe(true);

    // 依次经过 b、c、d 三个工具：没有现场标记的 a 也不会被淘汰。
    fireEvent.click(screen.getByRole("link", { name: "B" }));
    fireEvent.click(screen.getByRole("link", { name: "C" }));
    fireEvent.click(screen.getByRole("link", { name: "D" }));
    expect(cleanupPage).not.toHaveBeenCalled();
    const pageA = view.container.querySelector<HTMLElement>(
      '[data-tool-page="a"]',
    );
    expect(pageA).toBeInTheDocument();

    // 回到 a：计数还是 1，现场未丢。
    fireEvent.click(screen.getByRole("link", { name: "A" }));
    expect(screen.getByRole("button", { name: "a:1" })).toBeVisible();

    // 从未动过的空白页仍按 LRU 淘汰：a 有现场永驻，空白页超 2 个时
    // 最旧的 b 被清。
    fireEvent.click(screen.getByRole("link", { name: "B" }));
    fireEvent.click(screen.getByRole("link", { name: "C" }));
    fireEvent.click(screen.getByRole("link", { name: "D" }));
    fireEvent.click(screen.getByRole("link", { name: "E" }));
    expect(
      view.container.querySelector('[data-tool-page="b"]'),
    ).not.toBeInTheDocument();
    expect(
      view.container.querySelector('[data-tool-page="a"]'),
    ).toBeInTheDocument();
  });
});
