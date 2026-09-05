const { chromium } = require("playwright-core");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Run against `npm run dev -- --host 127.0.0.1` (the fixture is development-only).
(async () => {
  const baseUrl = process.env.TASK_STATE_BASE_URL || "http://127.0.0.1:1420";
  const catalog = JSON.parse(fs.readFileSync("public/tool-catalog.json", "utf8"));
  const states = [
    "loading", "queued", "running", "paused", "cancelled",
    "failed", "completed", "partial", "restored", "history_resume",
  ];
  // CSS-pixel widths model the usable viewport after 100% / 125% / 150% zoom.
  const widths = [1280, 1024, 854];
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "toolbox-task-state-"));
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-proxy-server"] });
  const failures = [];
  let cases = 0;
  try {
    for (const width of widths) {
      const context = await browser.newContext({ viewport: { width, height: 760 }, reducedMotion: "reduce" });
      const page = await context.newPage();
      page.setDefaultTimeout(120000);
      for (const tool of catalog) {
        for (const state of states) {
          cases += 1;
          const query = new URLSearchParams({ "task-state-fixture": "1", tool: tool.id, state });
          await page.goto(`${baseUrl}/?${query}`, { waitUntil: "commit", timeout: 120000 });
          await page.locator(".task-state-fixture").waitFor();
          const issues = await page.evaluate(() => {
            const root = document.querySelector(".task-state-fixture");
            const visible = (element) => element instanceof HTMLElement && element.getClientRects().length > 0;
            const describe = (element) => `${element.tagName.toLowerCase()}.${String(element.className).split(/\s+/).slice(0, 2).join(".")}`;
            const result = [];
            if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 2)
              result.push(`page overflow ${document.documentElement.scrollWidth}/${document.documentElement.clientWidth}`);
            for (const container of root.querySelectorAll(".form-card,.result-card,.job-progress,.error-box,.restore-notice,.task-row")) {
              if (!visible(container)) continue;
              const bounds = container.getBoundingClientRect();
              for (const child of container.querySelectorAll(":scope > *")) {
                if (!visible(child) || getComputedStyle(child).position === "absolute") continue;
                const rect = child.getBoundingClientRect();
                if (rect.left < bounds.left - 3 || rect.right > bounds.right + 3)
                  result.push(`${describe(child)} outside ${describe(container)}`);
              }
            }
            for (const element of root.querySelectorAll("button,select,input,textarea")) {
              if (!visible(element)) continue;
              const rect = element.getBoundingClientRect();
              if (rect.left < -2 || rect.right > innerWidth + 2) result.push(`${describe(element)} outside viewport`);
            }
            const state = root.getAttribute("data-state");
            const terminal = ["cancelled", "failed", "completed", "partial"].includes(state);
            if (terminal && root.querySelector(".job-cancel")) result.push("terminal state exposes cancel action");
            if (!terminal && !["restored", "history_resume"].includes(state) && !root.querySelector(".job-progress"))
              result.push("active state missing progress status");
            return [...new Set(result)];
          });
          if (issues.length) {
            failures.push({ width, tool: tool.id, state, issues });
            if (failures.length <= 12)
              await page.screenshot({ path: path.join(output, `${tool.id}-${state}-${width}.png`), fullPage: true });
          }
        }
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
  const report = { cases, failures };
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, cases, failureCount: failures.length, failures: failures.slice(0, 30) }, null, 2));
  if (failures.length) process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
