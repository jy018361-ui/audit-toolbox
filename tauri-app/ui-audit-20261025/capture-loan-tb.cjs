const { chromium } = require("playwright-core");
const path = require("node:path");
const out = path.resolve(__dirname, "shots", "pages");
(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-proxy-server"] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem("audit-toolbox.newbie-tour.v2", JSON.stringify({ newbieMode: false, workspaceDone: true }));
    localStorage.setItem("audit-toolbox.demo-data", "1");
  });
  await page.goto("http://127.0.0.1:1422/#/tools/loan_interest", { waitUntil: "domcontentloaded" });
  await page.locator(".page-header:visible").first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(400);
  await page.locator(".main button:visible").filter({ hasText: "TB＋JE" }).first().click();
  await page.waitForTimeout(500);
  const drop = page.locator(".file-drop-zone:visible").first();
  if (await drop.count()) {
    await drop.click();
    await page.waitForTimeout(1600);
    const dialog = page.locator(".job-dialog:visible");
    if (await dialog.count()) {
      await page.waitForTimeout(1000);
      const m = dialog.getByRole("button", { name: "最小化" });
      if (await m.count()) await m.click();
      await page.waitForTimeout(200);
    }
  }
  await page.screenshot({ path: path.join(out, "loan_tb-step1-uploaded.png"), fullPage: true });
  console.log("captured loan_tb-step1-uploaded");
  const next = page.locator(".main button:visible").filter({ hasText: "下一步：确认科目与利率" }).first();
  if (await next.count()) {
    await next.click();
    await page.waitForTimeout(1600);
    const d2 = page.locator(".job-dialog:visible");
    if (await d2.count()) {
      const m2 = d2.getByRole("button", { name: "最小化" });
      if (await m2.count()) await m2.click();
      await page.waitForTimeout(200);
    }
    await page.screenshot({ path: path.join(out, "loan_tb-step2-rates.png"), fullPage: true });
    console.log("captured loan_tb-step2-rates");
    const run = page.locator(".main button:visible").filter({ hasText: "下一步：测算与底稿" }).first();
    if (await run.count()) {
      await run.click();
      await page.waitForTimeout(1500);
      const cd = page.locator(".confirm-dialog:visible");
      if (await cd.count()) {
        await cd.locator("button:visible").last().click();
        await page.waitForTimeout(1200);
      }
      const d3 = page.locator(".job-dialog:visible");
      if (await d3.count()) {
        const m3 = d3.getByRole("button", { name: "最小化" });
        if (await m3.count()) await m3.click();
        await page.waitForTimeout(200);
      }
      await page.screenshot({ path: path.join(out, "loan_tb-step3-run.png"), fullPage: true });
      console.log("captured loan_tb-step3-run");
    }
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
