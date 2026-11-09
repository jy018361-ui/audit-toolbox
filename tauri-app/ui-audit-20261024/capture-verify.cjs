/* 修复验证截图：与 ui-audit-20261024/shots 里的旧图对照。 */
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");

const preview = "http://127.0.0.1:1422";
const dev = "http://127.0.0.1:1420";
const out = path.resolve(__dirname, "shots", "after-fix1");
fs.mkdirSync(out, { recursive: true });

async function settle(page) {
  await page.waitForTimeout(350);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }).catch(() => {});
}

async function capture(page, name) {
  await settle(page);
  await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
  console.log(`captured ${name}`);
}

async function clickButton(page, pattern) {
  const button = page.locator(".main button:visible").filter({ hasText: pattern }).first();
  if (await button.count()) { await button.click(); await page.waitForTimeout(700); return true; }
  return false;
}

async function activatePickers(page) {
  for (let pass = 0; pass < 5; pass += 1) {
    const candidates = await page.locator(".main button:visible").evaluateAll((buttons) => buttons.map((button, index) => {
      const text = (button.textContent || "").replace(/\s+/g, " ").trim();
      return {
        index, text,
        disabled: button.disabled || button.getAttribute("aria-disabled") === "true",
        picker: button.matches(".file-drop-zone") || /拖放|选择.*(?:文件|目录|文件夹)|添加文件/.test(text),
      };
    }));
    const candidate = candidates.find((b) => !b.disabled && b.picker);
    if (!candidate) break;
    await page.locator(".main button:visible").nth(candidate.index).click();
    await page.waitForTimeout(900);
    const dialog = page.locator(".job-dialog:visible");
    if (await dialog.count()) {
      await page.waitForTimeout(1000);
      const minimize = dialog.getByRole("button", { name: "最小化" });
      if (await minimize.count()) await minimize.click();
      await page.waitForTimeout(200);
    }
  }
}

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-proxy-server"] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem("audit-toolbox.newbie-tour.v2", JSON.stringify({ newbieMode: false, workspaceDone: true }));
    localStorage.setItem("audit-toolbox.demo-data", "1");
  });

  // 1. 折旧测算：映射下拉截断
  await page.goto(`${preview}/#/tools/fa_dep_calc`, { waitUntil: "domcontentloaded" });
  await page.locator(".page-header:visible").first().waitFor({ timeout: 15000 });
  await settle(page);
  await activatePickers(page);
  await capture(page, "fa_dep_calc-files-selected");

  // 2. 借款利息 TB＋JE：宽表裁切
  await page.goto(`${preview}/#/tools/loan_interest`, { waitUntil: "domcontentloaded" });
  await settle(page);
  await clickButton(page, "TB＋JE");
  const drop = page.locator(".file-drop-zone:visible").first();
  if (await drop.count()) {
    await drop.click();
    await page.waitForTimeout(1500);
    const dialog = page.locator(".job-dialog:visible");
    if (await dialog.count()) {
      await page.waitForTimeout(1000);
      const minimize = dialog.getByRole("button", { name: "最小化" });
      if (await minimize.count()) await minimize.click();
      await page.waitForTimeout(200);
    }
  }
  await capture(page, "loan_tb-step1-uploaded");
  await clickButton(page, "下一步：确认科目与利率");
  await page.waitForTimeout(1400);
  const dialog2 = page.locator(".job-dialog:visible");
  if (await dialog2.count()) {
    const minimize2 = dialog2.getByRole("button", { name: "最小化" });
    if (await minimize2.count()) await minimize2.click();
    await page.waitForTimeout(200);
  }
  await capture(page, "loan_tb-step2-rates");

  // 3. 文件夹清单：占位残留
  await page.goto(`${preview}/#/tools/file_list_directory`, { waitUntil: "domcontentloaded" });
  await settle(page);
  await activatePickers(page);
  await page.waitForTimeout(900);
  await capture(page, "file_list_directory-files-selected");

  // 4. 函证进度：清单表头裁切
  await page.goto(`${preview}/#/tools/confirmation_progress`, { waitUntil: "domcontentloaded" });
  await settle(page);
  await activatePickers(page);
  await clickButton(page, "检查数据");
  await page.waitForTimeout(1200);
  await capture(page, "confirmation_progress-step1");

  // 5. 任务状态：failed / partial（任务弹窗隐藏后内联状态）
  for (const state of ["failed", "partial", "running"]) {
    await page.goto(`${dev}/?task-state-fixture=1&tool=loan_interest&state=${state}`, { waitUntil: "commit" });
    await page.locator(".task-state-fixture").waitFor();
    if (state === "partial") {
      await page.getByRole("button", { name: /展开全部/ }).click().catch(() => {});
      await page.waitForTimeout(300);
    }
    await capture(page, `task-loan_interest-${state}`);
  }

  await browser.close();
  console.log("DONE verify");
})().catch((e) => { console.error(e); process.exit(1); });
