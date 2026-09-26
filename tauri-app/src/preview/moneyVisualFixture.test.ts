// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { handlers } from "./demo/money";

const previousUrl = window.location.href;

afterEach(() => {
  window.history.replaceState({}, "", previousUrl);
});

describe("借款页面视觉压力数据", () => {
  it("与虚构 TB 一致地提供 120 个科目和可见利率行", () => {
    window.history.replaceState({}, "", "/?demo=1&visualStress=1");
    const accounts = (handlers["loan.tb_accounts"]({}) as { accounts: Array<{ name: string }> }).accounts;
    const rates = (handlers["loan.prepare_rates"]({}) as { rows: Array<{ loanId: string }> }).rows;

    expect(accounts).toHaveLength(120);
    expect(accounts.some((account) => account.name.length > 35)).toBe(true);
    expect(rates).toHaveLength(40);
    expect(rates.every((row) => row.loanId.length > 0)).toBe(true);
  });
});
