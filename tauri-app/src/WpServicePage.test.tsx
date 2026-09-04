// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WpServicePage } from "./WpServicePage";

vi.mock("./api", () => ({
  engineCall: vi.fn(),
  jobCancel: vi.fn(),
  jobStart: vi.fn(),
  listenJobEvents: vi.fn().mockResolvedValue(() => undefined),
  pickPath: vi.fn().mockResolvedValue(null),
}));

const tool = {
  id: "wp_service_generator",
  name: "WP 服务单",
  description: "",
  category: "底稿工具",
  enabled: true,
} as never;

describe("WpServicePage", () => {
  it("shows the directory drop target and keyword input requirements", () => {
    render(<WpServicePage tool={tool} />);

    expect(screen.getByRole("button", { name: "拖放或单击选择目录" })).toBeInTheDocument();
    expect(screen.getByText("目录内文件要求")).toBeInTheDocument();
    expect(screen.getByText(/文件名包含“WP服务单”/)).toBeInTheDocument();
    expect(screen.getByText(/文件名包含“section list”/)).toBeInTheDocument();
    expect(screen.getByText(/每类输入文件只能保留一个/)).toBeInTheDocument();
    expect(screen.getByLabelText("本机处理")).toHaveAttribute("data-mode", "local");
    expect(screen.getByText("尚未生成结果")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1 选择目录" })).toHaveAttribute("aria-current", "step");
  });
});
