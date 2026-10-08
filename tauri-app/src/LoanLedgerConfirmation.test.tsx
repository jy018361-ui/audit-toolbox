// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  LoanLedgerConfirmation,
  ledgerInformationErrors,
  type LedgerInformation,
} from "./LoanLedgerConfirmation";
const row: LedgerInformation = {
  rowKey: "a",
  loanId: "借款甲",
  entity: "甲公司",
  opening: 0,
  added: 10000000,
  reduced: 2000000,
  closing: 8000000,
  originalClosing: 8000000,
  rateType: "fixed",
  spreadBps: 0,
  fixedRate: 0.04,
  contractStart: "2025-04-01",
  contractEnd: "2026-03-31",
  additions: [
    { date: "2025-04-01", amount: 5000000 },
    { date: "2025-05-01", amount: 5000000 },
  ],
  repayments: [{ date: "2025-06-01", amount: 2000000 }],
};
describe("台账信息确认", () => {
  it("允许多笔新增和还款，并校验汇总而不重复叠加", () => {
    expect(ledgerInformationErrors(row, "2025-01-01", "2025-12-31")).toEqual(
      [],
    );
    expect(
      ledgerInformationErrors(
        { ...row, added: 20000000 },
        "2025-01-01",
        "2025-12-31",
      ),
    ).toContain("新增明细合计与主行金额不一致");
  });
  it("空白期末不当零，期外默认到期日须修正", () => {
    const errors = ledgerInformationErrors(
      {
        ...row,
        closing: null,
        repayments: [{ date: "2026-03-31", amount: 2000000 }],
      },
      "2025-01-01",
      "2025-12-31",
    );
    expect(errors).toContain("请补齐四类非负金额，空白不视为零");
    expect(errors).toContain("还款日期须填写且在报告期内");
  });
  it("拒绝本金为负和不存在的日期", () => {
    expect(
      ledgerInformationErrors(
        { ...row, repayments: [{ date: "2025-02-30", amount: 2000000 }] },
        "2025-01-01",
        "2025-12-31",
      ),
    ).toContain("还款日期须填写且在报告期内");
    expect(
      ledgerInformationErrors(
        { ...row, repayments: [{ date: "2025-01-02", amount: 2000000 }] },
        "2025-01-01",
        "2025-12-31",
      ),
    ).toContain("还款后本金为负");
  });
  it("添加和删除辅助行，编辑金额与日期", () => {
    const edit = vi.fn();
    render(
      <LoanLedgerConfirmation
        rows={[row]}
        start="2025-01-01"
        end="2025-12-31"
        busy={false}
        onEdit={edit}
      />,
    );
    fireEvent.click(screen.getByText("添加新增明细"));
    expect(edit.mock.lastCall?.[0].additions).toHaveLength(3);
    fireEvent.change(screen.getByLabelText("借款甲新增日期1"), {
      target: { value: "2025-04-02" },
    });
    expect(edit.mock.lastCall?.[0].additions[0].date).toBe("2025-04-02");
    fireEvent.change(screen.getByLabelText("借款甲年初余额"), {
      target: { value: "100" },
    });
    expect(edit.mock.lastCall?.[0].opening).toBe(100);
    fireEvent.click(screen.getAllByText("删除")[0]);
    expect(edit.mock.lastCall?.[0].additions).toHaveLength(1);
  });
});
