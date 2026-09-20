// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { JargonTip } from "./JargonTip";

afterEach(cleanup);

describe("JargonTip", () => {
  it("Enter 和 Space 可开关提示，Escape 关闭", () => {
    render(<JargonTip term="JE" text="序时账" />);
    const trigger = screen.getByRole("button", { name: "什么是JE" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("tooltip")).toHaveTextContent("序时账");
    fireEvent.keyDown(trigger, { key: " " });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});
