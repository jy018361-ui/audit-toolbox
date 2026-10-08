// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  AudiPickFieldSelectionDialog,
  type AudiPickFieldSelectionGroup,
} from "./AudiPickFieldSelectionDialog";

afterEach(cleanup);

const loanGroup: AudiPickFieldSelectionGroup = {
  ruleId: "loan",
  ruleName: "借款·财务契约",
  ruleVersion: "4.2",
  fields: [
    { key: "page", label: "页码", required: true },
    { key: "excerpt", label: "合同原文摘录" },
    { key: "metric", label: "财务指标" },
  ],
  selectedFieldKeys: ["page", "excerpt"],
};

it("必选字段保持选中且不可取消，全选和仅必选会更新可选字段", () => {
  const onConfirm = vi.fn();
  render(
    <AudiPickFieldSelectionDialog
      open
      mode="single"
      groups={[loanGroup]}
      onClose={vi.fn()}
      onConfirm={onConfirm}
    />,
  );

  const group = screen.getByRole("region", { name: "借款·财务契约" });
  const page = within(group).getByRole("checkbox", { name: /页码/ });
  const excerpt = within(group).getByRole("checkbox", { name: /合同原文摘录/ });
  const metric = within(group).getByRole("checkbox", { name: /财务指标/ });

  expect(page).toBeChecked();
  expect(page).toBeDisabled();
  expect(excerpt).toBeChecked();
  expect(metric).not.toBeChecked();

  fireEvent.click(screen.getByRole("button", { name: "全选" }));
  expect(metric).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "仅必选" }));
  expect(page).toBeChecked();
  expect(excerpt).not.toBeChecked();
  expect(metric).not.toBeChecked();

  fireEvent.click(screen.getByRole("button", { name: "开始提取" }));
  expect(onConfirm).toHaveBeenCalledWith({
    fieldKeysByRuleId: { loan: ["page"] },
    skipExistingMatchingFieldSet: false,
  });
});

it("批量模式按模板分组返回字段，并可取消跳过已有相同字段组合", () => {
  const onConfirm = vi.fn();
  render(
    <AudiPickFieldSelectionDialog
      open
      mode="batch"
      groups={[
        { ...loanGroup, documentNames: ["C1借款合同.pdf", "C2借款合同.pdf"] },
        {
          ruleId: "revenue",
          ruleName: "收入底稿",
          fields: [
            { key: "page", label: "页码" },
            { key: "conclusion", label: "判断结论" },
          ],
          selectedFieldKeys: [],
          allFieldsRequired: true,
          documentNames: ["销售合同.pdf"],
        },
      ]}
      onClose={vi.fn()}
      onConfirm={onConfirm}
    />,
  );

  expect(screen.getByText("C1借款合同.pdf、C2借款合同.pdf")).toBeVisible();
  const revenue = screen.getByRole("region", { name: "收入底稿" });
  expect(within(revenue).getAllByRole("checkbox")).toHaveLength(2);
  within(revenue).getAllByRole("checkbox").forEach((checkbox) => {
    expect(checkbox).toBeChecked();
    expect(checkbox).toBeDisabled();
  });

  const skip = screen.getByRole("checkbox", { name: /跳过已有相同字段组合的底稿/ });
  expect(skip).toBeChecked();
  fireEvent.click(skip);
  fireEvent.click(screen.getByRole("button", { name: "开始提取" }));

  expect(onConfirm).toHaveBeenCalledWith({
    fieldKeysByRuleId: {
      loan: ["page", "excerpt"],
      revenue: ["page", "conclusion"],
    },
    skipExistingMatchingFieldSet: false,
  });
});

it("模板没有任何选中字段时阻止启动并给出说明", () => {
  render(
    <AudiPickFieldSelectionDialog
      open
      mode="single"
      groups={[{
        ruleId: "optional",
        ruleName: "选填模板",
        fields: [{ key: "memo", label: "备注" }],
        selectedFieldKeys: [],
      }]}
      onClose={vi.fn()}
      onConfirm={vi.fn()}
    />,
  );

  expect(screen.getByRole("alert")).toHaveTextContent("每组模板至少选择一个字段");
  expect(screen.getByRole("button", { name: "开始提取" })).toBeDisabled();
});

it("取消和关闭弹窗都通过 onClose 返回且提交中锁定关闭", () => {
  const onClose = vi.fn();
  const { rerender } = render(
    <AudiPickFieldSelectionDialog
      open
      mode="single"
      groups={[loanGroup]}
      onClose={onClose}
      onConfirm={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(onClose).toHaveBeenCalledTimes(1);

  rerender(
    <AudiPickFieldSelectionDialog
      open
      mode="single"
      groups={[loanGroup]}
      submitting
      onClose={onClose}
      onConfirm={vi.fn()}
    />,
  );
  expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "关闭" })).not.toBeInTheDocument();
});
