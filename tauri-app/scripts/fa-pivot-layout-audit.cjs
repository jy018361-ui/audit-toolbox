const { chromium } = require("playwright-core");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const baseUrl = process.env.FA_PIVOT_AUDIT_URL || "http://127.0.0.1:1422";
const widths = [1600, 1180, 1000];
const output = fs.mkdtempSync(path.join(os.tmpdir(), "toolbox-fa-pivot-layout-"));

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-proxy-server"] });
  const results = [];
  try {
    for (const width of widths) {
      const page = await browser.newPage({ viewport: { width, height: 760 }, reducedMotion: "reduce" });
      await page.goto(`${baseUrl}/?fa-pivot-fixture=1`, { waitUntil: "domcontentloaded" });
      await page.locator(".fa-tbje-pivot-preview").first().waitFor();
      const issues = await page.evaluate(() => {
        const tables = [...document.querySelectorAll(".fa-tbje-pivot-preview")];
        const issues = [];
        if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)
          issues.push("page horizontal overflow");
        const widths = tables.map((table) => [...table.querySelectorAll("thead th")]
          .map((cell) => cell.getBoundingClientRect().width));
        if (widths[0].some((value, index) => Math.abs(value - widths[1][index]) > 6))
          issues.push(`parallel column mismatch: ${JSON.stringify(widths)}`);
        for (const table of tables) {
          if (table.querySelector(".fa-tbje-pivot-total")?.cells.length !== 3 ||
              table.querySelector(".fa-tbje-pivot-total")?.cells[0].colSpan !== 2)
            issues.push("total row does not cover four columns");
          for (const cell of table.querySelectorAll("tbody td:first-child:not([colspan])")) {
            if (cell.getBoundingClientRect().height > 50) issues.push("entity label wraps vertically");
          }
          for (const cell of table.querySelectorAll("tbody td.fa-tbje-num")) {
            if (cell.scrollWidth > cell.clientWidth + 1) issues.push("amount overflows its column");
            if (getComputedStyle(cell).textAlign !== "right") issues.push("amount is not right-aligned");
          }
        }
        return issues;
      });
      await page.screenshot({ path: path.join(output, `${width}.png`), fullPage: true });
      results.push({ width, issues });
      await page.close();
    }
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify({ output, results }, null, 2));
  if (results.some((result) => result.issues.length)) process.exitCode = 1;
})().catch((error) => { console.error(error); process.exitCode = 1; });
