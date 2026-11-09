const { chromium } = require("playwright-core");
const path = require("node:path");
(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-proxy-server"] });
  const context = await browser.newContext({ viewport: { width: 1000, height: 680 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem("audit-toolbox.newbie-tour.v2", JSON.stringify({ newbieMode: false, workspaceDone: true }));
    localStorage.setItem("audit-toolbox.demo-data", "1");
  });
  await page.goto("http://127.0.0.1:1422/#/tools/loan_interest", { waitUntil: "domcontentloaded" });
  await page.locator(".page-header:visible").first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.resolve("ui-audit-20261024/shots/pages/verify-rail-1000-viewport.png") });
  console.log("done");
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
