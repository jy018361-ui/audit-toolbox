// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ColumnFilterMenu } from "./ColumnFilterMenu";

let anchor: HTMLButtonElement | undefined;
afterEach(() => {
  cleanup();
  anchor?.remove();
  anchor = undefined;
});

function openMenu(onClose = vi.fn(), onApply = vi.fn()) {
  anchor = document.createElement("button");
  anchor.textContent = "筛选科目";
  document.body.appendChild(anchor);
  anchor.focus();
  render(
    <ColumnFilterMenu
      field="科目"
      anchor={anchor}
      loading={false}
      data={{ values: ["现金", "银行存款"], total: 2, truncated: false, keyword: "" }}
      selected={[]}
      onSearch={() => undefined}
      onApply={onApply}
      onClose={onClose}
    />,
  );
  return { onClose, onApply };
}

it("目标科目初始不全选，搜索后全选只提交当前结果", () => {
  anchor = document.createElement("button");
  anchor.textContent = "选择目标科目";
  document.body.appendChild(anchor);
  const onApply = vi.fn();
  const props = {
    field: "目标科目",
    anchor,
    loading: false,
    selected: [] as string[],
    onSearch: () => undefined,
    onApply,
    onClose: () => undefined,
    defaultSelectAll: false,
  };
  const { rerender } = render(
    <ColumnFilterMenu
      {...props}
      data={{
        values: ["1001-库存现金", "6602-管理费用", "6801-所得税费用"],
        total: 3,
        truncated: false,
        keyword: "",
      }}
    />,
  );

  expect(
    (screen.getByRole("checkbox", { name: "（全选）" }) as HTMLInputElement).checked,
  ).toBe(false);
  rerender(
    <ColumnFilterMenu
      {...props}
      data={{
        values: ["6602-管理费用"],
        total: 1,
        truncated: false,
        keyword: "管理费用",
      }}
    />,
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "（全选）" }));
  fireEvent.click(screen.getByRole("button", { name: "确认选择" }));

  expect(onApply).toHaveBeenCalledWith(["6602-管理费用"]);
});

it("打开列筛选时聚焦搜索框，Escape 关闭后归还触发按钮", async () => {
  const { onClose } = openMenu();
  expect(screen.getByRole("dialog", { name: "筛选 科目" })).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "搜索科目" })));
  fireEvent.keyDown(window, { key: "Escape" });
  expect(onClose).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(anchor);
});

it("点击取消也归还焦点，点击确认保留所选值", () => {
  const { onClose, onApply } = openMenu();
  fireEvent.click(screen.getByRole("checkbox", { name: "现金" }));
  fireEvent.click(screen.getByRole("button", { name: "确认选择" }));
  expect(onApply).toHaveBeenCalledWith(["银行存款"]);
  expect(document.activeElement).toBe(anchor);
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(onClose).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(anchor);
});

it("上层确认框打开时 Escape 不连带关闭底下的筛选菜单", () => {
  const { onClose } = openMenu();
  const modal = document.createElement("div");
  modal.dataset.slot = "dialog-content";
  modal.dataset.state = "open";
  document.body.appendChild(modal);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(onClose).not.toHaveBeenCalled();
  modal.remove();
});

it("切换路由时关闭已打开的筛选浮层", () => {
  const { onClose } = openMenu();
  fireEvent(window, new PopStateEvent("popstate"));
  expect(onClose).toHaveBeenCalledOnce();
});
