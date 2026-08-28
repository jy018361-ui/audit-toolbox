// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useState } from "react";
import { MemoryRouter, NavLink, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import {
  PersistentToolPages,
  toolIdFromPathname,
} from "./PersistentToolPages";

describe("PersistentToolPages", () => {
  it("recognizes only complete tool routes", () => {
    expect(toolIdFromPathname("/tools/fx_audit")).toBe("fx_audit");
    expect(toolIdFromPathname("/tools/fx_audit/")).toBe("fx_audit");
    expect(toolIdFromPathname("/settings")).toBeUndefined();
    expect(toolIdFromPathname("/tools/a/more")).toBeUndefined();
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
});
