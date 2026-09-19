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
});
