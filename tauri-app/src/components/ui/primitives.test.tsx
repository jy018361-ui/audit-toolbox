// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Badge } from "./badge";
import { Button } from "./button";
import { Card } from "./card";
import { Input } from "./input";

afterEach(cleanup);

describe("shared UI primitives", () => {
  it("keeps the legacy button variants and exposes a guarded loading state", () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>执行</Button>);
    fireEvent.click(screen.getByRole("button", { name: "执行" }));
    expect(onClick).toHaveBeenCalledOnce();

    rerender(<Button loading loadingLabel="执行中…" onClick={onClick}>执行</Button>);
    const busy = screen.getByRole("button", { name: "执行中…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(busy.getAttribute("aria-busy")).toBe("true");
  });

  it.each(["neutral", "info", "success", "warning", "danger"] as const)(
    "publishes the %s badge variant",
    (variant) => {
      render(<Badge variant={variant}>状态</Badge>);
      expect(screen.getByText("状态").getAttribute("data-variant")).toBe(variant);
    },
  );

  it("publishes card semantics and compact input sizing", () => {
    render(<><Card variant="workspace" aria-label="工作区" /><Input controlSize="sm" aria-label="字段" /></>);
    expect(screen.getByLabelText("工作区").getAttribute("data-variant")).toBe("workspace");
    expect(screen.getByLabelText("字段").getAttribute("data-size")).toBe("sm");
  });
});
