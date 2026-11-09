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
  // 选文件 → 下一步
  const drop = page.locator(".file-drop-zone:visible").first();
  await drop.click();
  await page.waitForTimeout(1500);
  const dialog = page.locator(".job-dialog:visible");
  if (await dialog.count()) {
    await page.waitForTimeout(1000);
    const min = dialog.getByRole("button", { name: "最小化" });
    if (await min.count()) await min.click();
    await page.waitForTimeout(200);
  }
  const next = page.locator(".main button:visible").filter({ hasText: "下一步" }).first();
  await next.click();
  await page.waitForTimeout(1500);
  const dialog2 = page.locator(".job-dialog:visible");
  if (await dialog2.count()) {
    const min2 = dialog2.getByRole("button", { name: "最小化" });
    if (await min2.count()) await min2.click();
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(600);
  const info = await page.evaluate(() => {
    const out = [];
    for (const th of document.querySelectorAll("main th")) {
      const text = (th.textContent || "").replace(/\s+/g, "").trim();
      if (!th.getBoundingClientRect().width) continue;
      const table = th.closest("table");
      const box = th.closest(".data-table-scroll, .deposit-tier-table, [class*=table]");
      out.push({
        text: text.slice(0, 12),
        width: Math.round(th.getBoundingClientRect().width * 10) / 10,
        tableClass: table ? table.className : "(none)",
        containerClass: box ? String(box.className).slice(0, 60) : "(none)",
      });
    }
    return out.filter((row) => row.width < 70);
  });
  console.log(JSON.stringify(info, null, 1));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
