import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import baseline from "./styleLegacyBaseline.json";

const css = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
const patterns = {
  important: /!important/,
  transitionAll: /transition(?:-property)?\s*:\s*all\b/,
  literalColor: /#[\da-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(/i,
};

describe("共享设计系统静态守卫", () => {
  it.each(Object.entries(patterns))("明确冻结 styles.css 遗留 %s，禁止增加", (kind, pattern) => {
    const actual = css.split(/\r?\n/).filter(line => pattern.test(line) && !line.trimStart().startsWith("--") && !line.trimStart().startsWith("*")).map(line => line.trim()).sort();
    expect(actual).toEqual(baseline[kind as "important" | "transitionAll" | "literalColor"]);
  });

  it("页面 CSS 禁止非 token 颜色和全属性过渡，仅保留减弱动画的必要 important", () => {
    const directory = new URL("../../", import.meta.url);
    for (const file of readdirSync(directory).filter(name => name.endsWith(".css") && !["styles.css", "app-shell.css"].includes(name))) {
      const source = readFileSync(new URL(file, directory), "utf8");
      const lines = source.split(/\r?\n/).filter(line => !line.trimStart().startsWith("--") && !line.trimStart().startsWith("*"));
      expect(lines.filter(line => patterns.literalColor.test(line)), file).toEqual([]);
      expect(lines.filter(line => patterns.transitionAll.test(line)), file).toEqual([]);
      expect(lines.filter(line => patterns.important.test(line)).map(line => line.trim()), file).toEqual(file === "settings.css" ? baseline.pageImportant["settings.css"] : []);
    }
  });

  it("UI primitives 不使用 transition-all、important 或颜色字面量", () => {
    const directory = new URL("./", import.meta.url);
    for (const file of readdirSync(directory).filter(name => name.endsWith(".tsx") && !name.endsWith(".test.tsx"))) {
      const source = readFileSync(new URL(file, directory), "utf8");
      expect(source, file).not.toMatch(/transition-all|!important|#[\da-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(/i);
      expect(source, file).not.toMatch(/(?:bg|text|border|ring|outline|shadow)-(?:white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d+)/);
      expect(source, file).not.toMatch(/(?:["\s:])![a-z][\w-]*/);
    }
  });

  it("使用统一字体且不再覆盖 data-theme 的深色变量", () => {
    expect(css).not.toContain("Geist");
    expect(css).not.toMatch(/\n\.dark\s*\{/);
  });
});
