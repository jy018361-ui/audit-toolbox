// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Results as DepositResults } from "./DepositInterestPage";
import { Results as LoanResults } from "./LoanInterestPage";

describe("余额勾稽结果布局", () => {
  it("存款余额平铺，年平均余额留在明细，并区分未提供 JE", () => {
    render(
      <DepositResults
        rows={[{
          key: "account-1", entity: "甲公司", account: "1002 银行存款", auxiliary: "基本户",
          currency: "CNY", role: "deposit", tier: "demand", tierLabel: "活期",
          category: "demand", termLabel: "", tierMatchedBy: "账户名称", rateSource: "协议",
          annualRate: 0.01, rateResolved: true, rateWarning: "", openingBalance: 100,
          tbClosingBalance: 120, derivedClosingBalance: 119, jeReconciled: true,
          reconciliationDiff: -1, averageBalance: 110, calculatedInterest: 1.1,
          months: [], status: "待复核", note: "",
        }, {
          key: "account-2", entity: "甲公司", account: "1002 农行账户", auxiliary: "",
          currency: "CNY", role: "deposit", tier: "demand", tierLabel: "活期",
          category: "demand", termLabel: "", tierMatchedBy: "账户名称", rateSource: "协议",
          annualRate: 0.01, rateResolved: true, rateWarning: "", openingBalance: 50,
          tbClosingBalance: 60, derivedClosingBalance: 0, jeReconciled: false,
          reconciliationDiff: 0, averageBalance: 55, calculatedInterest: 0.55,
          months: [], status: "两点法推算", note: "",
        }]}
        result={{ summary: {} }}
        expanded="account-2"
        onExpand={vi.fn()}
        onOverride={vi.fn()}
        onRecalculate={vi.fn()}
        busy={false}
      />,
    );
    const table = document.querySelector(".deposit-table > table")!;
    expect(within(table as HTMLElement).getAllByRole("columnheader").map((node) => node.textContent?.trim()).slice(0, 10)).toEqual([
      "核算主体", "银行账户／科目", "存款类型", "年利率（%）", "期初余额", "期末 TB", "JE 推导期末", "余额差异", "利率来源", "测算利息",
    ]);
    const firstRow = within(table as HTMLElement).getByText("1002 银行存款").closest("tr")!;
    expect(firstRow.children[7]).toHaveTextContent("-1.00");
    expect(firstRow.children[10]).toHaveTextContent("待复核");
    expect(firstRow.children[11]).toHaveTextContent("已填利率");
    const secondRow = within(table as HTMLElement).getByText("1002 农行账户").closest("tr")!;
    expect(secondRow.children[6]).toHaveTextContent("—");
    expect(secondRow.children[7]).toHaveTextContent("—");
    expect(secondRow.children[10]).toHaveTextContent("未做JE核对");
    fireEvent.click(screen.getByRole("button", { name: "1002 农行账户的测算明细" }));
    expect(screen.getByText("年平均余额")).toBeVisible();
    expect(screen.getByText("两点法推算，无月度明细")).toBeVisible();
  });

  it("借款先列本金再列利率，差异保持推算减台账口径", () => {
    render(
      <LoanResults
        rows={[{
          entity: "甲公司", loanId: "工行流贷", currency: "CNY", openingPrincipal: 2_000_000,
          additions: 500_000, reductions: 300_000, closingPrincipal: 2_200_000,
          ledgerClosing: 2_190_000, rateType: "fixed", fixedRate: 0.038,
          calculatedInterest: 70_000, matchStatus: "待复核", matchBasis: "台账余额不符",
        }, {
          entity: "乙公司", loanId: "农行流贷", currency: "USD", openingPrincipal: 800_000,
          additions: 0, reductions: 100_000, closingPrincipal: 700_000,
          ledgerClosing: null, rateType: "fixed", fixedRate: 0.04,
          calculatedInterest: 28_000, matchStatus: "两点法推算", matchBasis: "无期末台账",
        }]}
        editRate={vi.fn()}
      />,
    );
    const table = document.querySelector(".loan-rate-table table")!;
    expect(within(table as HTMLElement).getAllByRole("columnheader").map((node) => node.textContent?.trim()).slice(0, 11)).toEqual([
      "主体", "借款标识", "币种", "期初本金", "本期增加", "本期归还", "推算期末", "台账／TB 期末", "本金差异", "本金勾稽", "利率类型",
    ]);
    const firstRow = within(table as HTMLElement).getByText("工行流贷").closest("tr")!;
    expect(firstRow.children[8]).toHaveTextContent("10,000.00");
    expect(firstRow.children[9]).toHaveTextContent("有差异");
    const secondRow = within(table as HTMLElement).getByText("农行流贷").closest("tr")!;
    expect(secondRow.children[7]).toHaveTextContent("—");
    expect(secondRow.children[8]).toHaveTextContent("—");
    expect(secondRow.children[9]).toHaveTextContent("未比较");
  });
});
