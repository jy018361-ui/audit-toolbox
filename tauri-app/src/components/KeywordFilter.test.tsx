// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeywordFilter, keywordFilterPredicate } from "./KeywordFilter";

describe("keywordFilterPredicate", () => {
  it("空关键词放行所有行", () => {
    const match = keywordFilterPredicate("");
    expect(match("1002 银行存款")).toBe(true);
    expect(match("")).toBe(true);
    expect(keywordFilterPredicate("   ")).toBeDefined();
  });
  it("单个关键词按子串、大小写不敏感匹配", () => {
    const match = keywordFilterPredicate("usd");
    expect(match("100332 USD BOC-CPCSC-SH")).toBe(true);
    expect(match("1002010017 银行存款-建设银行")).toBe(false);
  });
  it("多个关键词用空格分隔时逐词取与", () => {
    const match = keywordFilterPredicate("1002 建设");
    expect(match("1002010017 银行存款-建设银行")).toBe(true);
    expect(match("1002010017 银行存款-工商银行")).toBe(false);
  });
});

describe("KeywordFilter", () => {
  afterEach(cleanup);
  it("输入即回调，非空时显示命中数和清除按钮，点 × 清空", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <KeywordFilter value="" onChange={onChange} ariaLabel="筛选科目" placeholder="输入关键词" />,
    );
    const input = screen.getByLabelText("筛选科目");
    expect(input).toHaveAttribute("placeholder", "输入关键词");
    expect(screen.queryByRole("button", {name: "清除筛选"})).not.toBeInTheDocument();
    fireEvent.change(input, {target: {value: "银行"}});
    expect(onChange).toHaveBeenCalledWith("银行");

    rerender(
      <KeywordFilter value="银行" onChange={onChange} ariaLabel="筛选科目" matched={3} total={10} />,
    );
    expect(screen.getByText("3 / 10")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", {name: "清除筛选"}));
    expect(onChange).toHaveBeenCalledWith("");
  });
});
