// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { importLoanLedgerConfirmation, loanLedgerConfirmationRows, LoanLedgerConfirmationActions } from "./LoanLedgerConfirmationActions";
import type { LedgerInformation } from "./LoanLedgerConfirmation";

const mock = vi.hoisted(() => ({ engineCall: vi.fn(), pickPath: vi.fn(), openOutput: vi.fn() }));
vi.mock("./api", () => mock);
const rows: LedgerInformation[] = ["甲", "乙"].map(entity => ({
  rowKey: `ledger\u001f${entity}\u001f同名借款`, entity, loanId: "同名借款",
  opening: 10000000, added: 2000000, reduced: 1000000, closing: 11000000, originalClosing: 11000000,
  rateType: "fixed", fixedRate: 0.0438, benchmarkRate: null, spreadBps: -10,
  additions: [{ date: "2025-03-01", amount: 2000000, basis: "台账提取" }],
  repayments: [{ date: "2025-06-01", amount: 1000000, basis: "台账提取" }],
}));
beforeEach(() => {
  vi.clearAllMocks();
  mock.pickPath.mockResolvedValue("C:/ledger.xlsx");
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("下载全部借款并将排序后的金额、百分比及多笔事件回写正确主体", async () => {
  const changed = loanLedgerConfirmationRows(rows).reverse();
  changed[0].values[4] = "20,000,000.00";
  changed[0].values[9] = "4.45%";
  changed[0].values[12] = "2025-03-01；2025-04-01";
  changed[0].values[13] = "1,000,000; 1,000,000";
  mock.engineCall.mockResolvedValueOnce({ count: 2 }).mockResolvedValueOnce({ rows: changed });
  const onImport = vi.fn();
  render(<LoanLedgerConfirmationActions rows={rows} context="source" disabled={false} onImport={onImport} />);
  fireEvent.click(screen.getByRole("button", { name: "下载台账" }));
  await waitFor(() => expect(mock.engineCall).toHaveBeenCalledWith("account_confirmation.export", expect.objectContaining({
    documentKind: "loanLedger", rows: loanLedgerConfirmationRows(rows),
  })));
  fireEvent.click(screen.getByRole("button", { name: "上传台账" }));
  await waitFor(() => expect(onImport).toHaveBeenCalledOnce());
  const result = onImport.mock.lastCall![0];
  expect(result).toHaveLength(1);
  expect(result[0].fixedRate).toBeCloseTo(.0445, 12);
  expect(result[0]).toMatchObject({ rowKey: rows[1].rowKey, entity: "乙", opening: 20000000,
    originalClosing: 11000000, repayments: rows[1].repayments,
    additions: [{ date: "2025-03-01", amount: 1000000 }, { date: "2025-04-01", amount: 1000000 }],
  });
});

it("往返保留空期末、零利率、负BP、来源与明细行序", () => {
  const current = { ...rows[0], closing: null, fixedRate: 0,
    detailRows: [{ addDate: "2025-03-01", addAmount: 2000000, repayDate: "2025-06-01", repayAmount: 1000000 }] };
  expect(importLoanLedgerConfirmation(loanLedgerConfirmationRows([current]), [current])).toEqual([current]);
});

it.each([
  [4, "NaN", "非负数字"], [9, "-2%", "非负数字"], [11, "Infinity", "有效数字"],
  [12, "2025-02-30", "有效日期"], [13, "100;200", "笔数不一致"],
  [8, "未知", "固定或浮动"],
])("拒绝非法回传值且不修改原台账：列 %s", (column, value, error) => {
  const changed = loanLedgerConfirmationRows(rows);
  changed[0].values[9] = "5";
  changed[1].values[column as number] = value as string;
  expect(() => importLoanLedgerConfirmation(changed, rows)).toThrow(error as string);
  expect(rows[0].fixedRate).toBe(.0438);
});

it("回传未修改的台账不触发状态更新", async () => {
  mock.engineCall.mockResolvedValue({ rows: loanLedgerConfirmationRows(rows) });
  const onImport = vi.fn();
  render(<LoanLedgerConfirmationActions rows={rows} context="source" disabled={false} onImport={onImport} />);
  fireEvent.click(screen.getByRole("button", { name: "上传台账" }));
  await screen.findByText("台账没有修改，页面保持原样。");
  expect(onImport).not.toHaveBeenCalled();
});
