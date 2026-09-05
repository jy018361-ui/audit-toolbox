// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { NewbieModeToggle } from "./NewbieModeToggle";
import { loadTourState, saveTourState } from "./tourState";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("NewbieModeToggle", () => {
  it("默认开启", () => {
    render(<NewbieModeToggle />);
    expect(
      screen.getByRole("switch", { name: "新手模式" }),
    ).toHaveAttribute("data-state", "checked");
  });

  it("关闭后写入本地配置，重新挂载（模拟重启）保持关闭", () => {
    const { unmount } = render(<NewbieModeToggle />);
    fireEvent.click(screen.getByRole("switch", { name: "新手模式" }));
    expect(loadTourState().newbieMode).toBe(false);
    unmount();
    render(<NewbieModeToggle />);
    expect(
      screen.getByRole("switch", { name: "新手模式" }),
    ).toHaveAttribute("data-state", "unchecked");
  });

  it("尊重已保存的开启状态", () => {
    saveTourState({ newbieMode: true });
    render(<NewbieModeToggle />);
    expect(
      screen.getByRole("switch", { name: "新手模式" }),
    ).toHaveAttribute("data-state", "checked");
  });

  it("点击说明文字同样切换（品牌区是拖拽区，文字是同义按钮）", () => {
    render(<NewbieModeToggle />);
    fireEvent.click(screen.getByText("新手模式"));
    expect(loadTourState().newbieMode).toBe(false);
    expect(
      screen.getByRole("switch", { name: "新手模式" }),
    ).toHaveAttribute("data-state", "unchecked");
  });
});
