// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AudiPickResultStatus } from "./AudiPickPage";

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
