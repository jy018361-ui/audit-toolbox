// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ErrorBox } from "./ErrorBox";

describe("ErrorBox", () => {
  it("长错误默认显示摘要，并可展开独立滚动的去重详情", () => {
    const repeated = "无法读取工作簿，请关闭 Excel 后重试。".repeat(16);
    render(<ErrorBox error={`${repeated}\n${"很长的路径".repeat(50)}`} />);

    const toggle = screen.getByRole("button", { name: "查看详情" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText(/…/)).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "收起详情" })).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelector(".error-box-message")).toHaveClass("error-box-message--expanded");
    expect(screen.getByText(/已合并 15 条重复信息/)).toBeInTheDocument();
  });
});
