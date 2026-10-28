const { chromium } = require("playwright-core");
const path = require("node:path");
(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-proxy-server"] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem("audit-toolbox.newbie-tour.v2", JSON.stringify({ newbieMode: true, workspaceDone: false }));
    localStorage.setItem("audit-toolbox.demo-data", "1");
  });
  await page.goto("http://127.0.0.1:1420/?overlay-fixture=step", { waitUntil: "commit" });
  await page.locator(".overlay-state-fixture").waitFor();
  await page.waitForTimeout(1800);
  await page.screenshot({ path: path.resolve(__dirname, "shots/overlays/overlay-step.png") });
  console.log("recaptured overlay-step with newbie mode");
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
