/*
 * 视觉审核专用截图采集（弹窗与提示层）：OverlayStateFixture / TaskStateFixture 夹具
 * 仅在开发服务器渲染。运行前提：npx vite --host 127.0.0.1 --port 1420。
 */
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");

const baseUrl = process.env.DEV_URL || "http://127.0.0.1:1420";
const output = path.resolve(__dirname, "shots", "overlays");
fs.mkdirSync(output, { recursive: true });

const scenarios = [
  "confirm", "sync", "sync-pill", "job-single", "job-multi", "tour",
  "step", "success", "jargon", "fuzzy", "job-success-stack",
  "step-confirm-stack", "jargon-confirm-stack", "currency", "filter",
  "filter-confirm-stack", "job-pill-confirm-stack", "dual-pill",
];
const taskTools = ["loan_interest", "fx_audit", "Excel_Merger", "deposit_interest"];
const taskStates = ["running", "paused", "failed", "completed", "partial"];

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-proxy-server"] });
  try {
    const context = await browser.newContext({
      viewport: { width: 1600, height: 900 },
      reducedMotion: "reduce",
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    await page.addInitScript(() => {
      localStorage.setItem("audit-toolbox.newbie-mode", "0");
      localStorage.setItem("audit-toolbox.newbie-tour.v2", JSON.stringify({ newbieMode: false, workspaceDone: true }));
      localStorage.setItem("audit-toolbox.demo-data", "1");
    });

    for (const scenario of scenarios) {
      await page.goto(`${baseUrl}/?overlay-fixture=${scenario}`, { waitUntil: "commit" });
      await page.locator(".overlay-state-fixture").waitFor();
      if (scenario === "jargon") await page.getByRole("button", { name: /^什么是/ }).focus().catch(() => {});
      if (scenario === "job-pill-confirm-stack") {
        await page.locator(".job-dialog-pill").waitFor();
        await page.getByRole("dialog", { name: "停止后台任务并清空记录？" }).waitFor();
      }
      if (scenario === "dual-pill") {
        await page.locator(".job-dialog-pill").waitFor();
        await page.locator(".sync-busy-pill").waitFor();
      }
      if (scenario === "filter-confirm-stack") {
        await page.locator(".ts-filter-menu").waitFor();
        await page.getByRole("dialog", { name: "确认当前筛选？" }).waitFor();
      }
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(output, `overlay-${scenario}.png`), fullPage: true });
      console.log(`captured overlay-${scenario}`);
    }

    for (const tool of taskTools) {
      for (const state of taskStates) {
        const query = new URLSearchParams({ "task-state-fixture": "1", tool, state });
        await page.goto(`${baseUrl}/?${query}`, { waitUntil: "commit" });
        await page.locator(".task-state-fixture").waitFor();
        await page.evaluate(async () => {
          await document.fonts.ready;
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        });
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(output, `task-${tool}-${state}.png`), fullPage: true });
        console.log(`captured task-${tool}-${state}`);
      }
    }

    // 窄屏抽屉导航
    const narrow = await browser.newContext({
      viewport: { width: 1000, height: 680 }, reducedMotion: "reduce", deviceScaleFactor: 1,
    });
    const npage = await narrow.newPage();
    await npage.addInitScript(() => {
      localStorage.setItem("audit-toolbox.newbie-mode", "0");
      localStorage.setItem("audit-toolbox.newbie-tour.v2", JSON.stringify({ newbieMode: false, workspaceDone: true }));
      localStorage.setItem("audit-toolbox.demo-data", "1");
    });
    await npage.goto(`${baseUrl}/#/`, { waitUntil: "domcontentloaded" });
    await npage.locator(".sidebar-rail-menu").waitFor();
    await npage.locator(".sidebar-rail-menu").click();
    await npage.locator("#app-sidebar.drawer-open").waitFor();
    await npage.waitForTimeout(300);
    await npage.screenshot({ path: path.join(output, "overlay-drawer-1000.png") });
    console.log("captured overlay-drawer-1000");

    // 设置页软件更新面板
    await npage.goto(`${baseUrl}/#/settings`, { waitUntil: "domcontentloaded" });
    await npage.getByRole("button", { name: /软件更新|发现新版本/ }).click();
    await npage.locator("#settings-update-panel").waitFor();
    await npage.waitForTimeout(400);
    await npage.screenshot({ path: path.join(output, "overlay-settings-update.png"), fullPage: true });
    console.log("captured overlay-settings-update");

    await browser.close();
  } finally {
    await browser.close();
  }
  console.log("DONE overlays");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
