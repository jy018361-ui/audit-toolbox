import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./deposit-interest.css", import.meta.url), "utf8");

describe("存款测算结果行色", () => {
  it("普通格与前两列固定格共用待复核行背景色", () => {
    expect(css).toMatch(/\.deposit-table td\s*\{\s*background:\s*var\(--deposit-row-bg, var\(--card\)\)/);
    expect(css).toMatch(/td:first-child\s*\{[^}]*background:\s*var\(--deposit-row-bg, var\(--card\)\)/);
    expect(css).toMatch(/td:nth-child\(2\)\s*\{[^}]*background:\s*var\(--deposit-row-bg, var\(--card\)\)/);
    expect(css).toMatch(/\.deposit-review-row\s*\{\s*--deposit-row-bg:/);
  });
  it("长账户名在局部滚动表内单行省略，不把一行撑成多行", () => {
    expect(css).toMatch(/\.deposit-table > table\s*\{[^}]*width:\s*max-content/);
    expect(css).toMatch(/td:nth-child\(2\)\s*\{[^}]*min-width:\s*312px/);
    expect(css).toMatch(/\.deposit-table \.deposit-account-cell strong,[\s\S]*?white-space:\s*nowrap/);
  });
  it("结果对比的指标卡等高，运算符居中", () => {
    expect(css).toMatch(/\.deposit-page \.fx-bridge-equation\s*\{[^}]*align-items:\s*stretch/);
    expect(css).toMatch(/\.deposit-page \.fx-bridge-equation \.fx-bridge-metric\s*\{[^}]*align-content:\s*center/);
    expect(css).toMatch(/\.deposit-page \.fx-bridge-equation \.fx-operator\s*\{[^}]*align-self:\s*center/);
  });
});
