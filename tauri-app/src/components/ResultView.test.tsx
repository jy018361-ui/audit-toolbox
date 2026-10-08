// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ResultView } from "./ResultView";

afterEach(cleanup);

// P1 回归：结果对象没有 message 时，默认文案不得宣称"处理完成"——
// 失败/取消后页面常仍展示上一轮成功的结果（或失败任务的部分产物），
// 宣称完成会让审计师把失败当成功、误用旧底稿。
describe("ResultView 默认文案与残留结果提示", () => {
  it("有结果文件时用中性表述，不宣称处理完成", () => {
    render(
      <ResultView value={{ outputPaths: ["C:\\底稿\\A1_现金.xlsx"] }} />,
    );
    expect(
      screen.getByText("以下为已生成的结果文件，可打开核对。"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/处理完成/)).toBeNull();
  });

  it("没有结果文件时只说运行结束", () => {
    render(<ResultView value={{ rows: 3 }} />);
    expect(screen.getByText("运行结束。")).toBeInTheDocument();
    expect(screen.queryByText(/处理完成/)).toBeNull();
  });

  it("引擎自带 message 时优先展示原文案", () => {
    render(<ResultView value={{ message: "已生成 2 份底稿。", rows: 2 }} />);
    expect(screen.getByText("已生成 2 份底稿。")).toBeInTheDocument();
  });

  it("stale 时显示最近一次任务未成功的提示，默认不显示", () => {
    const value = { outputPaths: ["C:\\底稿\\D1_固定资产.xlsx"] };
    const { rerender } = render(<ResultView value={value} />);
    expect(screen.queryByRole("note")).toBeNull();
    rerender(<ResultView value={value} stale />);
    expect(screen.getByRole("note")).toHaveTextContent(
      "最近一次任务未成功完成",
    );
  });
});
