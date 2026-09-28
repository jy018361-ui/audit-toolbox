// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AudiPickAssociationDialog } from "./AudiPickAssociationDialog";

afterEach(cleanup);

it("隐藏已归入其他合同组的主合同和关联资料", () => {
  render(<AudiPickAssociationDialog
    anchorId="b"
    documents={[
      { id: "a", name: "A合同.pdf" },
      { id: "a1", name: "A1关联资料.pdf" },
      { id: "b", name: "B合同.pdf" },
      { id: "b1", name: "B1可关联资料.pdf" },
    ]}
    groups={[{ id: "ga", anchorFileId: "a", members: [{ fileId: "a1", role: "补充协议/变更" }] }]}
    onClose={vi.fn()}
    onSave={vi.fn(async () => undefined)}
  />);

  expect(screen.queryByRole("checkbox", { name: /A合同\.pdf/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("checkbox", { name: /A1关联资料\.pdf/ })).not.toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: /B1可关联资料\.pdf/ })).toBeInTheDocument();
  expect(screen.getByText("已隐藏 2 份已归入其他合同组的文件")).toBeInTheDocument();
});

it("按文件名自然排序，搜索不会丢失已选文件", () => {
  render(<AudiPickAssociationDialog
    anchorId="main"
    documents={[
      { id: "main", name: "主合同.pdf" },
      { id: "c10", name: "C10资料.pdf" },
      { id: "c2", name: "C2资料.pdf" },
      { id: "c1", name: "C1资料.pdf" },
    ]}
    groups={[]}
    onClose={vi.fn()}
    onSave={vi.fn(async () => undefined)}
  />);

  const list = screen.getByRole("list", { name: "可关联文件" });
  expect(within(list).getAllByRole("checkbox").map((item) => item.getAttribute("aria-label"))).toEqual([
    "选择C1资料.pdf",
    "选择C2资料.pdf",
    "选择C10资料.pdf",
  ]);

  fireEvent.click(screen.getByRole("checkbox", { name: "选择C10资料.pdf" }));
  fireEvent.change(screen.getByPlaceholderText("搜索可关联文件"), { target: { value: "C1资料" } });
  expect(screen.queryByRole("checkbox", { name: "选择C10资料.pdf" })).not.toBeInTheDocument();
  fireEvent.change(screen.getByPlaceholderText("搜索可关联文件"), { target: { value: "" } });
  expect(screen.getByRole("checkbox", { name: "选择C10资料.pdf" })).toBeChecked();
});
