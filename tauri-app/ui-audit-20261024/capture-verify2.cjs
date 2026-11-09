/* 第二/三批修复验证截图 */
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");

const preview = "http://127.0.0.1:1422";
const dev = "http://127.0.0.1:1420";
const out = path.resolve(__dirname, "shots", "after-fix2");
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
  await page.screenshot({ path: path.join(out, `${name}.png`) });
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

  // —— 弹窗夹具（第二批自制） ——
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, reducedMotion: "reduce" });
  const fpage = await ctx.newPage();
  fpage.setDefaultTimeout(60000);
  await fpage.addInitScript(() => {
    localStorage.setItem("audit-toolbox.newbie-tour.v2", JSON.stringify({ newbieMode: false, workspaceDone: true }));
    localStorage.setItem("audit-toolbox.demo-data", "1");
  });
  for (const scenario of ["confirm", "job-multi", "job-pill-confirm-stack", "dual-pill"]) {
    await fpage.goto(`${dev}/?overlay-fixture=${scenario}`, { waitUntil: "commit" });
    await fpage.locator(".overlay-state-fixture").waitFor();
    if (scenario === "job-pill-confirm-stack") {
      await fpage.locator(".job-dialog-pill").waitFor();
      await fpage.getByRole("dialog", { name: "停止后台任务并清空记录？" }).waitFor();
    }
    if (scenario === "dual-pill") {
      await fpage.locator(".job-dialog-pill").waitFor();
      await fpage.locator(".sync-busy-pill").waitFor();
    }
    await fpage.waitForTimeout(500);
    await capture(fpage, `overlay-${scenario}`);
  }
  await ctx.close();

  // —— 引导（满屏卡 → 限高气泡） ——
  const tctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, reducedMotion: "reduce" });
  const tpage = await tctx.newPage();
  await tpage.addInitScript(() => {
    localStorage.setItem("audit-toolbox.newbie-tour.v2", JSON.stringify({ newbieMode: true, workspaceDone: false }));
    localStorage.setItem("audit-toolbox.demo-data", "1");
  });
  await tpage.goto(`${dev}/?overlay-fixture=tour`, { waitUntil: "commit" });
  await tpage.locator(".overlay-state-fixture").waitFor();
  await tpage.waitForTimeout(2500);
  await capture(tpage, "overlay-tour");
  await tctx.close();

  // —— 页面（第三批子代理 + 存款/汇兑） ——
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem("audit-toolbox.newbie-tour.v2", JSON.stringify({ newbieMode: false, workspaceDone: true }));
    localStorage.setItem("audit-toolbox.demo-data", "1");
  });

  // 看账：批次 chips + 透视多选
  await page.goto(`${preview}/#/tools/kanzhang`, { waitUntil: "domcontentloaded" });
  await page.locator(".page-header:visible").first().waitFor({ timeout: 15000 });
  await settle(page);
  await activatePickers(page);
  for (const label of ["读取并自动映射", "下一步：条件筛选"]) {
    await clickButton(page, label).catch(() => {});
    await page.waitForTimeout(800);
    const dialog = page.locator(".job-dialog:visible");
    if (await dialog.count()) {
      const minimize = dialog.getByRole("button", { name: "最小化" });
      if (await minimize.count()) await minimize.click();
      await page.waitForTimeout(200);
    }
  }
  await capture(page, "kanzhang-batches");
  await clickButton(page, "下一步：透视与导出").catch(() => {});
  await page.waitForTimeout(800);
  await capture(page, "kanzhang-pivot");

  // 正负数：批次卡宽度
  await page.goto(`${preview}/#/tools/je_sign_mark`, { waitUntil: "domcontentloaded" });
  await settle(page);
  await activatePickers(page);
  await clickButton(page, "读取并自动映射").catch(() => {});
  await page.waitForTimeout(900);
  const dlg = page.locator(".job-dialog:visible");
  if (await dlg.count()) {
    const m = dlg.getByRole("button", { name: "最小化" });
    if (await m.count()) await m.click();
    await page.waitForTimeout(200);
  }
  await capture(page, "je_sign-batches");

  // TS：斜体与眉题
  await page.goto(`${preview}/#/tools/ts_manager`, { waitUntil: "domcontentloaded" });
  await settle(page);
  await activatePickers(page);
  await page.waitForTimeout(800);
  await capture(page, "ts-files-selected");

  // 文件夹清单：状态条
  await page.goto(`${preview}/#/tools/file_list_directory`, { waitUntil: "domcontentloaded" });
  await settle(page);
  await activatePickers(page);
  await page.waitForTimeout(1200);
  await capture(page, "file_list-files-selected");

  // 函证：步骤完成态
  await page.goto(`${preview}/#/tools/confirmation_progress`, { waitUntil: "domcontentloaded" });
  await settle(page);
  await activatePickers(page);
  await clickButton(page, "检查数据").catch(() => {});
  await page.waitForTimeout(1000);
  await clickButton(page, "下一步：报告范围").catch(() => {});
  await page.waitForTimeout(600);
  await clickButton(page, "生成进度报告").catch(() => {});
  await page.waitForTimeout(1500);
  const cdlg = page.locator(".job-dialog:visible");
  if (await cdlg.count()) {
    const cm = cdlg.getByRole("button", { name: "最小化" });
    if (await cm.count()) await cm.click();
    await page.waitForTimeout(200);
  }
  await capture(page, "confirmation-step4");

  // 汇兑：成功条
  await page.goto(`${preview}/#/tools/fx_audit`, { waitUntil: "domcontentloaded" });
  await settle(page);
  await activatePickers(page);
  for (const label of ["读取并识别", "下一步：确认TB科目类型", "测算预览"]) {
    await clickButton(page, label).catch(() => {});
    await page.waitForTimeout(900);
    const d = page.locator(".job-dialog:visible");
    if (await d.count()) {
      const m = d.getByRole("button", { name: "最小化" });
      if (await m.count()) await m.click();
      await page.waitForTimeout(200);
    }
  }
  await clickButton(page, "生成Excel底稿").catch(() => {});
  await page.waitForTimeout(1600);
  const fxdlg = page.locator(".job-dialog:visible");
  if (await fxdlg.count()) {
    const m = fxdlg.getByRole("button", { name: "最小化" });
    if (await m.count()) await m.click();
    await page.waitForTimeout(200);
  }
  await capture(page, "fx-step4");

  // 会议：输入框与文案
  await page.goto(`${preview}/#/tools/meeting_minutes`, { waitUntil: "domcontentloaded" });
  await settle(page);
  await activatePickers(page);
  await capture(page, "meeting-files-selected");

  await browser.close();
  console.log("DONE verify2");
})().catch((e) => { console.error(e); process.exit(1); });
