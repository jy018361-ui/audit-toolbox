const { chromium } = require("playwright-core");
const path = require("node:path");
(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-proxy-server"] });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 }, reducedMotion: "reduce" })).newPage();
  await page.addInitScript(() => {
    localStorage.setItem("audit-toolbox.newbie-tour.v2", JSON.stringify({ newbieMode: false, workspaceDone: true }));
    localStorage.setItem("audit-toolbox.demo-data", "1");
  });
  await page.goto("http://127.0.0.1:1422/#/tools/kanzhang", { waitUntil: "domcontentloaded" });
  await page.locator(".page-header:visible").first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(500);
  const drop = page.locator(".file-drop-zone:visible").first();
  if (await drop.count()) { await drop.click(); await page.waitForTimeout(1500); }
  const d = page.locator(".job-dialog:visible");
  if (await d.count()) { const m = d.getByRole("button", { name: "最小化" }); if (await m.count()) await m.click(); await page.waitForTimeout(200); }
  for (const label of ["读取并自动映射", "下一步：科目筛选"]) {
    const b = page.locator(".main button:visible").filter({ hasText: label }).first();
    if (await b.count() && await b.isEnabled()) { await b.click(); await page.waitForTimeout(1100); }
  }
  const d2 = page.locator(".job-dialog:visible");
  if (await d2.count()) { const m2 = d2.getByRole("button", { name: "最小化" }); if (await m2.count()) await m2.click(); await page.waitForTimeout(200); }
  await page.screenshot({ path: path.resolve("ui-audit-20261025/shots-final/pages/kanzhang-step3-8.png"), fullPage: true });
  console.log("ok");
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
