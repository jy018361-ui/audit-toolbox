/*
 * 补充截图：演示驱动没走到的状态。
 * - 借款利息 TB＋JE 模式：「确认科目与利率」步骤、明细衔接口径弹窗、测算步骤
 * - 两列模糊匹配：必选下拉 + 开始匹配
 * - WP Roll Forward：新建项目 → 配置
 * 运行前提：npx vite preview --host 127.0.0.1 --port 1422。
 */
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");

const baseUrl = process.env.AUDIT_URL || "http://127.0.0.1:1422";
const output = path.resolve(__dirname, "shots", "pages");
fs.mkdirSync(output, { recursive: true });

async function settle(page) {
  await page.waitForTimeout(350);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }).catch(() => {});
}

async function capture(page, name) {
  await settle(page);
  await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
  const scrollable = await page.evaluate(() => {
    const main = document.querySelector("main, .main");
    return main && main.scrollHeight > main.clientHeight + 40;
  }).catch(() => false);
  if (scrollable) {
    await page.evaluate(() => {
      const main = document.querySelector("main, .main");
      main?.scrollTo({ top: main.scrollHeight, behavior: "instant" });
    });
    await page.waitForTimeout(220);
    await page.screenshot({ path: path.join(output, `${name}-bottom.png`) });
    await page.evaluate(() => {
      const main = document.querySelector("main, .main");
      main?.scrollTo({ top: 0, behavior: "instant" });
    });
  }
  console.log(`captured ${name}`);
}

async function clickButton(page, pattern) {
  const button = page.locator(".main button:visible").filter({ hasText: pattern }).first();
  if (await button.count()) {
    await button.click();
    await page.waitForTimeout(600);
    return true;
  }
  return false;
}

async function minimizeJob(page) {
  const dialog = page.locator(".job-dialog:visible");
  if (await dialog.count()) {
    await page.waitForTimeout(1200);
    const minimize = dialog.getByRole("button", { name: "最小化" });
    if (await minimize.count()) await minimize.click();
    await page.waitForTimeout(200);
  }
}

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-proxy-server"] });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    reducedMotion: "reduce",
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem("audit-toolbox.newbie-mode", "0");
    localStorage.setItem("audit-toolbox.newbie-tour.v2", JSON.stringify({ newbieMode: false, workspaceDone: true }));
    localStorage.setItem("audit-toolbox.demo-data", "1");
  });

  // —— 借款利息 TB＋JE 模式 ——
  try {
    await page.goto(`${baseUrl}/#/tools/loan_interest`, { waitUntil: "domcontentloaded" });
    await page.locator(".page-header:visible").first().waitFor({ timeout: 15000 });
    await settle(page);
    await clickButton(page, "TB＋JE");
    await settle(page);
    // 统一上传框（拖放区）
    const drop = page.locator(".file-drop-zone:visible").first();
    if (await drop.count()) {
      await drop.click();
      await page.waitForTimeout(1600);
      await minimizeJob(page);
      await settle(page);
    }
    await capture(page, "loan_tb-step1-uploaded");
    await clickButton(page, "下一步：确认科目与利率");
    await page.waitForTimeout(1400);
    await minimizeJob(page);
    await capture(page, "loan_tb-step2-rates");
    // 明细衔接口径弹窗
    if (await clickButton(page, "选择明细衔接口径")) {
      await page.waitForTimeout(400);
      await capture(page, "loan_tb-matching-dialog");
      await clickButton(page, "取消");
    }
    // 继续测算
    if (await clickButton(page, "下一步：测算与底稿")) {
      await page.waitForTimeout(1500);
      const confirmDialog = page.locator(".confirm-dialog:visible");
      if (await confirmDialog.count()) {
        await capture(page, "loan_tb-run-confirm");
        await confirmDialog.locator("button:visible").last().click();
        await page.waitForTimeout(1200);
      }
      await minimizeJob(page);
      await capture(page, "loan_tb-step3-run");
    }
  } catch (error) {
    console.log(`WARN loan_tb: ${String(error).slice(0, 300)}`);
  }

  // —— 两列模糊匹配 ——
  try {
    await page.goto(`${baseUrl}/#/tools/fuzzy_match`, { waitUntil: "domcontentloaded" });
    await page.locator(".page-header:visible").first().waitFor({ timeout: 15000 });
    await settle(page);
    const drop = page.locator(".file-drop-zone:visible").first();
    if (await drop.count()) {
      await drop.click();
      await page.waitForTimeout(1400);
      await minimizeJob(page);
    }
    // 必填下拉逐个补齐
    const selects = page.locator(".main select:visible");
    for (let index = 0; index < await selects.count(); index += 1) {
      await selects.nth(index).evaluate((element) => {
        if (element.disabled || element.value) return;
        const option = [...element.options].find((item) => item.value && !item.disabled);
        if (option) {
          element.value = option.value;
          element.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });
    }
    await settle(page);
    await capture(page, "fuzzy_match-configured");
    if (await clickButton(page, "开始匹配")) {
      await page.waitForTimeout(1800);
      const confirmDialog = page.locator(".confirm-dialog:visible");
      if (await confirmDialog.count()) {
        await capture(page, "fuzzy_match-run-confirm");
        await confirmDialog.locator("button:visible").last().click();
        await page.waitForTimeout(1500);
      }
      await minimizeJob(page);
      await capture(page, "fuzzy_match-result");
    }
  } catch (error) {
    console.log(`WARN fuzzy: ${String(error).slice(0, 300)}`);
  }

  // —— WP Roll Forward 项目流程 ——
  try {
    await page.goto(`${baseUrl}/#/tools/audit_roll_forward`, { waitUntil: "domcontentloaded" });
    await page.locator(".page-header:visible").first().waitFor({ timeout: 15000 });
    await settle(page);
    if (await clickButton(page, "新建项目")) {
      await page.waitForTimeout(900);
      await capture(page, "roll_forward-project-created");
      const browse = page.getByRole("button", { name: "浏览", exact: true });
      for (let index = 0; index < await browse.count(); index += 1) {
        await browse.nth(index).click();
        await page.waitForTimeout(500);
      }
      const selectAll = page.getByRole("button", { name: "全选科目" });
      if (await selectAll.count()) await selectAll.click();
      await settle(page);
      await capture(page, "roll_forward-configured");
    }
  } catch (error) {
    console.log(`WARN roll_forward: ${String(error).slice(0, 300)}`);
  }

  await browser.close();
  console.log("DONE extra");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
