// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountConfirmationActions } from "./AccountConfirmationActions";

const mock = vi.hoisted(() => ({ engineCall: vi.fn(), openOutput: vi.fn(), pickPath: vi.fn() }));
vi.mock("./api", () => ({ engineCall: mock.engineCall, openOutput: mock.openOutput, pickPath: mock.pickPath }));

const columns = [
  { key: "account", title: "科目" },
  { key: "role", title: "分类", editable: true, options: ["计息", "排除"] },
];
const rows = [
  { key: "a", values: ["1002 银行存款", "计息"] },
  { key: "b", values: ["1001 现金", "排除"] },
];
const props = { tool: "deposit" as const, title: "存款", context: "current-source", columns, rows };

beforeEach(() => {
  mock.engineCall.mockReset();
  mock.openOutput.mockReset();
  mock.pickPath.mockReset();
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("科目确认表", () => {
  it("下载完整清单并按行键回传排序后的修改", async () => {
    mock.pickPath.mockResolvedValueOnce("C:/confirmation.xlsx").mockResolvedValueOnce("C:/confirmation.xlsx");
    mock.engineCall.mockResolvedValueOnce({ count: 2 }).mockResolvedValueOnce({
      rows: [
        { key: "b", values: ["1001 现金", "计息"] },
        { key: "a", values: ["1002 银行存款", "计息"] },
      ],
    });
    const onImport = vi.fn();
    render(<AccountConfirmationActions {...props} onImport={onImport} />);
    fireEvent.click(screen.getByRole("button", { name: "下载科目确认表" }));
    await waitFor(() => expect(mock.engineCall).toHaveBeenCalledWith("account_confirmation.export", expect.objectContaining({ rows })));
    fireEvent.click(screen.getByRole("button", { name: "回传科目确认表" }));
    await waitFor(() => expect(onImport).toHaveBeenCalledWith([{ key: "b", values: ["1001 现金", "计息"] }]));
  });

  it("下载成功后提供一键打开所在文件夹的链接", async () => {
    mock.pickPath.mockResolvedValueOnce("C:/audit/存款科目确认表.xlsx");
    mock.engineCall.mockResolvedValueOnce({ count: 2 });
    render(<AccountConfirmationActions {...props} onImport={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "下载科目确认表" }));
    const link = await screen.findByRole("button", { name: /打开所在文件夹/ });
    expect(link).toHaveAttribute("title", "C:/audit/存款科目确认表.xlsx");
    fireEvent.click(link);
    expect(mock.openOutput).toHaveBeenCalledWith("C:/audit/存款科目确认表.xlsx");
  });

  it("拒绝 Excel 绕过下拉框填入非法分类", async () => {
    mock.pickPath.mockResolvedValue("C:/confirmation.xlsx");
    mock.engineCall.mockResolvedValue({ rows: [
      { key: "a", values: ["1002 银行存款", "未知"] },
      { key: "b", values: ["1001 现金", "排除"] },
    ] });
    const onImport = vi.fn();
    render(<AccountConfirmationActions {...props} onImport={onImport} />);
    fireEvent.click(screen.getByRole("button", { name: "回传科目确认表" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("不是下拉框允许的值"));
    expect(onImport).not.toHaveBeenCalled();
  });
});
