// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { JargonTip } from "./JargonTip";

const TERM = "组合匹配键";
const TEXT = "用一列或多列拼成唯一识别一张卡片的键。";

afterEach(() => {
  cleanup();
});

describe("JargonTip", () => {
  it("默认只渲染问号按钮，不渲染气泡文本", () => {
    render(<JargonTip term={TERM} text={TEXT} />);
    expect(
      screen.getByRole("button", { name: `什么是${TERM}` }),
    ).toBeInTheDocument();
    expect(screen.queryByText(TEXT)).not.toBeInTheDocument();
  });

  it("悬停显示气泡，移开后消失", () => {
    render(<JargonTip term={TERM} text={TEXT} />);
    const button = screen.getByRole("button", { name: `什么是${TERM}` });
    fireEvent.mouseEnter(button);
    expect(screen.getByRole("tooltip")).toHaveTextContent(TEXT);
    fireEvent.mouseLeave(button);
    expect(screen.queryByText(TEXT)).not.toBeInTheDocument();
  });

  it("键盘聚焦同样能看气泡，失焦即消失", () => {
    render(<JargonTip term={TERM} text={TEXT} />);
    const button = screen.getByRole("button", { name: `什么是${TERM}` });
    fireEvent.focus(button);
    expect(screen.getByRole("tooltip")).toHaveTextContent(TEXT);
    expect(button).toHaveAttribute("aria-describedby");
    fireEvent.blur(button);
    expect(screen.queryByText(TEXT)).not.toBeInTheDocument();
    expect(button).not.toHaveAttribute("aria-describedby");
  });
});
