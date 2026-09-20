// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ConfirmDialogHost, confirmDialog } from "./ConfirmDialog";

describe("ConfirmDialog", () => {
  afterEach(cleanup);

  it("点确认按钮返回 true 并关闭对话框", async () => {
    let result: boolean | undefined;
    render(<ConfirmDialogHost />);
    void confirmDialog({
      title: "确认删除项目",
      message: "该项目下的全部资料会一并删除，且无法恢复。",
      tone: "danger",
    }).then((value) => {
      result = value;
    });

    expect(await screen.findByText("确认删除项目")).toBeInTheDocument();
    expect(
      await screen.findByText("该项目下的全部资料会一并删除，且无法恢复。"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "删除" }));

    await waitFor(() => expect(result).toBe(true));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("点取消按钮返回 false，默认按钮文案为取消与确认", async () => {
    let result: boolean | undefined;
    render(<ConfirmDialogHost />);
    void confirmDialog({
      title: "执行前 CRA 确认",
      message: "确定本次不使用这些 CRA 并继续吗？",
    }).then((value) => {
      result = value;
    });

    expect(await screen.findByRole("button", { name: "确认" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    await waitFor(() => expect(result).toBe(false));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("新的确认请求覆盖上一个，被覆盖的按取消处理", async () => {
    let first: boolean | undefined;
    let second: boolean | undefined;
    render(<ConfirmDialogHost />);
    void confirmDialog({ title: "第一个确认" }).then((value) => {
      first = value;
    });
    await screen.findByText("第一个确认");

    void confirmDialog({
      title: "第二个确认",
      confirmLabel: "继续",
    }).then((value) => {
      second = value;
    });

    expect(await screen.findByText("第二个确认")).toBeInTheDocument();
    await waitFor(() => expect(first).toBe(false));

    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    await waitFor(() => expect(second).toBe(true));
  });

  it("长标题限制两行，重复错误合并且正文独立滚动", async () => {
    render(<ConfirmDialogHost />);
    void confirmDialog({
      title: "超长确认标题".repeat(20),
      message: "无法读取工作簿，请关闭 Excel 后重试。".repeat(8),
      tone: "danger",
    });

    const title = await screen.findByRole("heading");
    expect(title).toHaveClass("line-clamp-2");
    expect(title).toHaveAttribute("title", "超长确认标题".repeat(20));
    expect(screen.getByText(/已合并 7 条重复信息/)).toBeInTheDocument();
    expect(document.querySelector(".confirm-dialog-body")).toHaveClass("overflow-y-auto");
    expect(document.querySelector(".confirm-dialog-footer")).toHaveClass("shrink-0");
  });
});
