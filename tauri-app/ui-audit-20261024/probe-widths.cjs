const { chromium } = require("playwright-core");
(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.addInitScript(() => {
    localStorage.setItem("audit-toolbox.newbie-tour.v2", JSON.stringify({ newbieMode: false, workspaceDone: true }));
    localStorage.setItem("audit-toolbox.demo-data", "1");
  });
  await page.goto("http://127.0.0.1:1422/#/tools/deposit_interest", { waitUntil: "domcontentloaded" });
  await page.locator(".page-header:visible").first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(600);
  const drop = page.locator(".file-drop-zone:visible").first();
  await drop.click();
  await page.waitForTimeout(1500);
  const dialog = page.locator(".job-dialog:visible");
  if (await dialog.count()) {
    await page.waitForTimeout(1000);
    const min = dialog.getByRole("button", { name: "最小化" });
    if (await min.count()) await min.click();
    await page.waitForTimeout(300);
  }
  const next = page.locator(".main button:visible").filter({ hasText: "下一步" }).first();
  await next.click();
  await page.waitForTimeout(1600);
  const dialog2 = page.locator(".job-dialog:visible");
  if (await dialog2.count()) {
    const min2 = dialog2.getByRole("button", { name: "最小化" });
    if (await min2.count()) await min2.click();
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(800);
  const info = await page.evaluate(() => {
    const w = (el) => (el ? Math.round(el.getBoundingClientRect().width) : null);
    const tier = document.querySelector(".deposit-tier-table");
    const tierCard = tier?.closest("[data-slot=card-content]")?.closest("[data-slot=card]");
    const tierTh = [...document.querySelectorAll(".deposit-tier-table th")].map((th) => Math.round(th.getBoundingClientRect().width));
    const grids = [...document.querySelectorAll("main .form-grid, main [style*=grid], main .deposit-grid, main .dep-step-grid")].map((g) => ({ cls: String(g.className).slice(0, 50), w: w(g), display: getComputedStyle(g).display, cols: getComputedStyle(g).gridTemplateColumns }));
    const dtScrolls = [...document.querySelectorAll(".data-table-scroll")].map((el) => ({ w: w(el), sw: el.scrollWidth }));
    return { tier: w(tier), tierCard: w(tierCard), tierTh, grids, dtScrolls };
  });
  console.log(JSON.stringify(info, null, 1));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
