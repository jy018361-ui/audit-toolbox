/*
 * 全量视觉验收采集（2026-10-25）：演示数据导入 → 动态任务 → 全部层级截图。
 * 覆盖：应用壳 3 页 + 19 个工具的初始态/选件后/每一步 + 窄屏抽查 + 18 类弹窗
 * 提示层夹具 + 任务状态 4 工具 × 5 状态。输出 ui-audit-20261025/shots/。
 * 前提：preview 1422（页面）+ dev 1420（夹具，仅开发服务器渲染）。
 */
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");

const preview = "http://127.0.0.1:1422";
const dev = "http://127.0.0.1:1420";
const out = path.resolve(__dirname, "shots-final");
fs.mkdirSync(path.join(out, "pages"), { recursive: true });
fs.mkdirSync(path.join(out, "overlays"), { recursive: true });

const catalog = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "public", "tool-catalog.json"), "utf8"));
const narrowRoutes = new Set(["/", "/settings", "/tools/loan_interest", "/tools/fa_list", "/tools/kanzhang", "/tools/fx_audit"]);
const progressPattern = /^(?:读取|检查|加载|继续|下一步|开始|扫描|重新扫描|识别|运行前检查|结转|处理全部公司|筛选预览|套用审计关注|按一级科目|上传|确认|测算|生成|匹配)/;
const unsafePattern = /^(?:清空|删除|停止|取消|返回|导出|保存|恢复默认|退出)/;
const safeName = (value) => value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "state";

async function settle(page) {
  await page.waitForTimeout(320);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }).catch(() => {});
}

async function capture(page, folder, name) {
  await settle(page);
  const file = path.join(out, folder, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  const scrollable = await page.evaluate(() => {
    const main = document.querySelector("main, .main");
    return main && main.scrollHeight > main.clientHeight + 40;
  }).catch(() => false);
  if (scrollable) {
    await page.evaluate(() => {
      const main = document.querySelector("main, .main");
      main?.scrollTo({ top: main.scrollHeight, behavior: "instant" });
    });
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(out, folder, `${name}-bottom.png`) });
    await page.evaluate(() => {
      const main = document.querySelector("main, .main");
      main?.scrollTo({ top: 0, behavior: "instant" });
    });
  }
  console.log(`captured ${name}`);
}

async function currentButtons(page) {
  return page.locator(".main button:visible").evaluateAll((buttons) => buttons.map((button, index) => {
    const text = (button.textContent || "").replace(/\s+/g, " ").trim();
    return {
      index, text,
      disabled: button.disabled || button.getAttribute("aria-disabled") === "true",
      workflowNavigation: Boolean(button.closest(".step-indicator, [aria-label='任务步骤']")),
      picker: button.matches(".file-drop-zone") || /拖放|选择.*(?:文件|目录|文件夹|借款台账)|添加文件/.test(text),
    };
  }));
}

/** 等任务弹窗出现→截图留档→最小化（同一任务只截一次）。 */
let jobDialogCaptured = 0;
async function dismissJobOverlay(page) {
  const confirm = page.locator(".confirm-dialog:visible");
  if (await confirm.count()) {
    const actions = confirm.locator("button:visible");
    if (await actions.count()) {
      const labels = await actions.allTextContents();
      const confirmButton = labels.find((label) => /确认|确定|继续/.test(label));
      await (confirmButton ? actions.nth(labels.indexOf(confirmButton)) : actions.last()).click();
      await settle(page);
      const dialog = page.locator(".job-dialog:visible");
      if (await dialog.count() && jobDialogCaptured < 3) {
        await page.screenshot({ path: path.join(out, "pages", `job-dialog-live-${++jobDialogCaptured}.png`) });
        console.log("captured job-dialog-live");
      }
      const minimize = dialog.getByRole("button", { name: "最小化" });
      if (await minimize.count()) await minimize.click();
      await page.waitForTimeout(200);
    }
  }
  const dialog = page.locator(".job-dialog:visible");
  if (!(await dialog.count())) return;
  const finished = await dialog.waitFor({ state: "hidden", timeout: 2500 }).then(() => true, () => false);
  if (!finished) {
    const minimize = dialog.getByRole("button", { name: "最小化" });
    if (await minimize.count()) await minimize.click();
    await page.waitForTimeout(150);
  }
}

async function activatePickers(page) {
  const clicked = [];
  for (let pass = 0; pass < 5; pass += 1) {
    const buttons = await currentButtons(page);
    const candidate = buttons.find((b) => !b.disabled && !b.workflowNavigation && b.picker && !clicked.includes(b.text));
    if (!candidate) break;
    await page.locator(".main button:visible").nth(candidate.index).click();
    clicked.push(candidate.text);
    await settle(page);
    await dismissJobOverlay(page);
  }
  return clicked;
}

async function advanceWorkflow(page, tag) {
  const seen = new Set();
  for (let step = 0; step < 8; step += 1) {
    await dismissJobOverlay(page);
    const buttons = await currentButtons(page);
    const candidates = buttons.filter((b) => !b.disabled && !b.workflowNavigation &&
      progressPattern.test(b.text) && !unsafePattern.test(b.text) && !/^\d/.test(b.text));
    const candidate = candidates.find((b) => !seen.has(b.text));
    if (!candidate) break;
    seen.add(candidate.text);
    await page.locator(".main button:visible").nth(candidate.index).evaluate((button) => button.click());
    await page.waitForTimeout(/(?:读取|检查|加载|开始|识别)/.test(candidate.text) ? 1400 : 500);
    await dismissJobOverlay(page);
    await capture(page, "pages", `${tag}-step${step + 1}-${safeName(candidate.text)}`);
  }
}

async function newPage(browser, viewport) {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce", deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem("audit-toolbox.newbie-mode", "0");
    localStorage.setItem("audit-toolbox.newbie-tour.v2", JSON.stringify({ newbieMode: false, workspaceDone: true }));
    localStorage.setItem("audit-toolbox.demo-data", "1");
  });
  return { context, page };
}

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-proxy-server"] });

  /* ============ 一、应用壳 + 全部工具全步骤（1600 主屏 + 关键页 1000 窄屏） ============ */
  for (const viewport of [{ width: 1600, height: 900, label: "" }, { width: 1000, height: 680, label: "@1000" }]) {
    const { context, page } = await newPage(browser, viewport);
    const tag = (v) => `${v}${viewport.label}`;
    for (const route of ["/", "/history", "/settings"]) {
      await page.goto(`${preview}/#${route}`, { waitUntil: "domcontentloaded" });
      await page.locator(".page-header:visible").first().waitFor({ timeout: 15000 }).catch(() => {});
      await settle(page);
      await capture(page, "pages", tag(route === "/" ? "shell-workspace" : `shell${route.replaceAll("/", "_")}`));
    }
    for (const tool of catalog) {
      if (viewport.label && !narrowRoutes.has(tool.route)) continue;
      console.log(`driving ${tool.id} ${viewport.label}`);
      const base = tag(tool.id);
      try {
        await page.goto(`${preview}/#${tool.route}`, { waitUntil: "domcontentloaded" });
        await page.locator(".page-header:visible").first().waitFor({ timeout: 15000 }).catch(() => {});
        await settle(page);
        await capture(page, "pages", `${base}-initial`);
        if (tool.id === "audipick") continue;

        // 借款利息补 TB＋JE 模式
        if (tool.id === "loan_interest" && !viewport.label) {
          const tbButton = page.locator(".main button:visible").filter({ hasText: "TB＋JE" }).first();
          if (await tbButton.count()) {
            await tbButton.click();
            await settle(page);
            await capture(page, "pages", "loan_tb-step1-uploaded");
            const next = page.locator(".main button:visible").filter({ hasText: "下一步：确认科目与利率" }).first();
            if (await next.count()) {
              await next.click();
              await page.waitForTimeout(1400);
              await dismissJobOverlay(page);
              await capture(page, "pages", "loan_tb-step2-rates");
              if (await page.locator(".main button:visible").filter({ hasText: "下一步：测算与底稿" }).first().count()) {
                await page.locator(".main button:visible").filter({ hasText: "下一步：测算与底稿" }).first().click();
                await page.waitForTimeout(1500);
                await dismissJobOverlay(page);
                await capture(page, "pages", "loan_tb-step3-run");
              }
            }
          }
        }
        const pickers = await activatePickers(page);
        if (pickers.length) {
          await page.waitForTimeout(1100);
          await dismissJobOverlay(page);
          await capture(page, "pages", `${base}-files-selected`);
        }
        await advanceWorkflow(page, base);

        if (tool.id === "fa_list") {
          const review = page.getByRole("button", { name: "复核科目分类" });
          if (await review.isEnabled().catch(() => false)) {
            await review.click();
            await settle(page);
            await capture(page, "pages", `${base}-account-review`);
            await advanceWorkflow(page, `${base}-review`);
          }
          const cardsTab = page.getByRole("tab", { name: "两期固定资产清单" });
          if (await cardsTab.count()) {
            await cardsTab.click();
            await settle(page);
            await capture(page, "pages", `${base}-cards-initial`);
            if ((await activatePickers(page)).length) {
              await page.waitForTimeout(900);
              await capture(page, "pages", `${base}-cards-files-selected`);
            }
            await advanceWorkflow(page, `${base}-cards`);
          }
        }
      } catch (error) {
        console.log(`WARN ${tool.id}: ${String(error).slice(0, 160)}`);
      }
    }
    await context.close();
  }

  /* ============ 二、弹窗与提示层夹具（18 场景，按场景切换新手模式） ============ */
  {
    const { context, page } = await newPage(browser, { width: 1600, height: 900 });
    page.setDefaultTimeout(60000);
    for (const scenario of ["confirm", "sync", "sync-pill", "job-single", "job-multi", "tour", "step", "success",
      "jargon", "fuzzy", "job-success-stack", "step-confirm-stack", "jargon-confirm-stack", "currency",
      "filter", "filter-confirm-stack", "job-pill-confirm-stack", "dual-pill"]) {
      // step/success 场景的引导提示只在新手模式下渲染。
      await page.addInitScript(() => {
        localStorage.setItem("audit-toolbox.newbie-tour.v2",
          JSON.stringify({ newbieMode: ["step", "success", "tour"].includes(new URLSearchParams(location.search).get("overlay-fixture")), workspaceDone: false }));
      }).catch(() => {});
      await page.goto(`${dev}/?overlay-fixture=${scenario}`, { waitUntil: "commit" });
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
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      });
      await page.waitForTimeout(450);
      await capture(page, "overlays", `overlay-${scenario}`);
    }
    // 窄屏抽屉 + 设置更新面板
    const { context: nctx, page: npage } = await newPage(browser, { width: 1000, height: 680 });
    await npage.goto(`${dev}/#/`, { waitUntil: "domcontentloaded" });
    await npage.locator(".sidebar-rail-menu").waitFor();
    await npage.locator(".sidebar-rail-menu").click();
    await npage.locator("#app-sidebar.drawer-open").waitFor();
    await npage.waitForTimeout(300);
    await capture(npage, "overlays", "overlay-drawer-1000");
    await npage.goto(`${dev}/#/settings`, { waitUntil: "domcontentloaded" });
    await npage.getByRole("button", { name: /软件更新|发现新版本/ }).click();
    await npage.locator("#settings-update-panel").waitFor();
    await npage.waitForTimeout(400);
    await capture(npage, "overlays", "overlay-settings-update");
    await nctx.close();
    await context.close();
  }

  /* ============ 三、任务状态组件（共用组件，4 工具 × 5 状态抽样） ============ */
  {
    const { context, page } = await newPage(browser, { width: 1600, height: 900 });
    for (const tool of ["loan_interest", "fx_audit", "Excel_Merger", "deposit_interest"]) {
      for (const state of ["running", "paused", "failed", "completed", "partial"]) {
        await page.goto(`${dev}/?task-state-fixture=1&tool=${tool}&state=${state}`, { waitUntil: "commit" });
        await page.locator(".task-state-fixture").waitFor();
        await page.evaluate(async () => {
          await document.fonts.ready;
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        });
        await page.waitForTimeout(300);
        await capture(page, "overlays", `task-${tool}-${state}`);
      }
    }
    await context.close();
  }

  await browser.close();
  console.log("DONE acceptance-capture");
})().catch((e) => { console.error(e); process.exit(1); });
