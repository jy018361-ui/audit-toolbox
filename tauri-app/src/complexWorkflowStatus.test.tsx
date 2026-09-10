// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AudiPickResultStatus } from "./AudiPickPage";
import { RollForwardResult } from "./RollForwardPage";

afterEach(cleanup);

describe("合同结果状态", () => {
  it("未处理时不暗示成功", () => {
    render(<AudiPickResultStatus hasResult={false} missingCount={0} />);
    expect(screen.getByText("等待处理")).toHaveAttribute("data-variant", "neutral");
  });
  it("待补资料优先于已有结果", () => {
    render(<AudiPickResultStatus hasResult missingCount={2} />);
    expect(screen.getByText("需补充资料")).toHaveAttribute("data-variant", "warning");
  });
  it("已有结果仍需人工复核", () => {
    render(<AudiPickResultStatus hasResult missingCount={0} />);
    expect(screen.getByText("已有处理结果 · 待人工复核")).toBeInTheDocument();
  });
});

describe("年度结转结果", () => {
  it("汇总失败并保留下一步指导", () => {
    render(<RollForwardResult value={{ results: [{ success: false, subjectCode: "1001" }, { success: true, subjectCode: "1002" }] }} />);
    expect(screen.getByRole("status")).toHaveTextContent("需处理：1 项未完成");
    expect(screen.getByRole("status")).toHaveTextContent("重试对应科目");
  });
  it("已生成但有警告时不显示完全成功", () => {
    render(<RollForwardResult value={{ results: [{ success: true, warnings: ["请核对日期"] }] }} />);
    expect(screen.getByRole("status")).toHaveTextContent("已生成 · 有待复核提示");
  });
  it("显示文件名并通过 title 保留完整来源路径", () => {
    const path = "C:\\客户\\上年底稿.xlsx";
    render(<RollForwardResult value={{ details: [{ code: "1001", priorPath: path }], valid: true }} />);
    expect(screen.getByTitle(path)).toHaveTextContent("上年底稿.xlsx");
  });
});
