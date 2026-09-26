import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./loan-interest.css", import.meta.url), "utf8");

describe("借款测算宽表", () => {
  it("让金额列撑开局部滚动表，不把相邻金额压成一串", () => {
    expect(css).toMatch(/\.loan-rate-table table\s*\{[^}]*width:\s*max-content/);
    expect(css).toMatch(/\.loan-rate-table table\s*\{[^}]*table-layout:\s*auto/);
    expect(css).toMatch(/\.loan-rate-table th:nth-child\(n \+ 4\)[\s\S]*?min-width:\s*158px/);
  });
  it("本金汇总金额保持单行，窄桌面窗口使用两列卡片", () => {
    expect(css).toMatch(/\.loan-bridge-equation \.fx-bridge-metric strong,[\s\S]*?white-space:\s*nowrap/);
    expect(css).toMatch(/@media \(min-width: 901px\) and \(max-width: 1180px\)[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  });
});
