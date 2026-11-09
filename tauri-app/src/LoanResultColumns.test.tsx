// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { Results } from "./LoanInterestPage";
import { normalizeHeaderLabel, writeStoredWidths } from "./components/useTableColumnResize";

afterEach(() => { cleanup(); localStorage.clear(); });

const rows = [{
  entity: "上海观安", loanId: "200103 招商银行上海真如支行",
  openingPrincipal: 119200000, additions: 163200000, reductions: 143600000,
  closingPrincipal: 138800000, rateType: "fixed" as const, fixedRate: 0.03,
}];
const mount = () => render(<Results rows={rows} editRate={() => undefined} />);
const labels = () => Array.from(screen.getAllByRole("columnheader"), th => normalizeHeaderLabel(th.textContent));
const columns = () => Array.from(screen.getByRole("table").querySelectorAll("col"));

it("紧凑布局不恢复旧版上千像素的列宽", () => {
  const first = mount();
  const headers = labels();
  first.unmount();
  // 本机真实历史列宽：本期增加被保存为 1791 像素。
  writeStoredWidths("loan.results", headers, [110, 306, 56, 158, 1791, 158, 158, 158, 158, 110, 105, 145, 116, 120, 158, 110]);
  mount();
  expect(columns()[4].style.width).toBe("");
  expect(columns()[4]).toHaveAttribute("width", "168");
  expect(screen.getByRole("table")).toHaveStyle({ width: "2352px" });
  expect(screen.queryByRole("button", { name: "重置列宽" })).not.toBeInTheDocument();
});

it("紧凑布局仍保留用户后续主动调整的列宽", () => {
  const first = mount();
  const headers = labels();
  first.unmount();
  const widths = [96, 340, 112, 168, 400, 168, 168, 168, 168, 100, 104, 144, 100, 112, 168, 128];
  writeStoredWidths("loan.results.compact-v2", headers, widths);
  mount();
  expect(columns()[4]).toHaveStyle({ width: "400px" });
  expect(columns()[1]).toHaveStyle({ width: "340px" });
});
