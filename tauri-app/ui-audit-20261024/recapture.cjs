const { chromium } = require("playwright-core");
const path = require("node:path");
(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-proxy-server"] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const out = path.resolve("ui-audit-20261024/shots/overlays");
  for (const scenario of ["step", "success", "job-success-stack"]) {
    await page.addInitScript(() => {
      localStorage.setItem("audit-toolbox.newbie-tour.v2", JSON.stringify({ newbieMode: true, workspaceDone: false }));
      localStorage.setItem("audit-toolbox.demo-data", "1");
    });
    await page.goto(`http://127.0.0.1:1420/?overlay-fixture=${scenario}`, { waitUntil: "commit" });
    await page.locator(".overlay-state-fixture").waitFor();
    await page.waitForTimeout(2500);
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    });
    await page.screenshot({ path: path.join(out, `overlay-${scenario}.png`), fullPage: true });
    console.log(`recaptured overlay-${scenario}`);
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
