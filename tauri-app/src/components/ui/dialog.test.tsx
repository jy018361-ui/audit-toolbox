// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog";

afterEach(cleanup);
describe("共享弹窗", () => {
  it("提供名称、说明、关闭按钮和内部滚动边界", () => {
    const onOpenChange = vi.fn();
    render(<Dialog open onOpenChange={onOpenChange}><DialogContent><DialogTitle>确认操作</DialogTitle><DialogDescription>操作说明</DialogDescription></DialogContent></Dialog>);
    const dialog = screen.getByRole("dialog", { name: "确认操作" });
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    expect(dialog.className).toContain("overflow-y-auto");
    expect(dialog.className).toContain("overscroll-contain");
    expect(dialog.className).toContain("motion-reduce:animate-none");
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
  it("默认支持 Escape 关闭", () => {
    const onOpenChange = vi.fn();
    render(<Dialog open onOpenChange={onOpenChange}><DialogContent><DialogTitle>确认操作</DialogTitle><DialogDescription>操作说明</DialogDescription></DialogContent></Dialog>);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
