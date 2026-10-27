/*
 * 视觉审核专用截图采集：把每个工具页的真实步骤全部驱动出来并整页截图。
 * 复用 scripts/workflow-layout-audit.cjs 的驱动逻辑，但只截图不做几何判定。
 * 运行前提：npx vite preview --host 127.0.0.1 --port 1422（生产构建）。
 */
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");

const baseUrl = process.env.AUDIT_URL || "http://127.0.0.1:1422";
const output = path.resolve(__dirname, "shots", "pages");
fs.mkdirSync(output, { recursive: true });

const catalog = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "public", "tool-catalog.json"), "utf8"));
const viewports = [
  { width: 1600, height: 900, label: "1600" },
  { width: 1000, height: 680, label: "1000" },
];
const narrowRoutes = new Set(["/", "/settings", "/tools/loan_interest", "/tools/fa_list", "/tools/kanzhang", "/tools/fx_audit"]);

const normalize = (value) => value.replace(/\s+/g, " ").trim();
const progressPattern = /^(?:读取|检查|加载|继续|下一步|开始|扫描|重新扫描|识别|运行前检查|结转|处理全部公司|筛选预览|套用审计关注|按一级科目|上传|确认|测算|生成|匹配)/;
const unsafePattern = /^(?:清空|删除|停止|取消|返回|导出|保存|恢复默认|退出)/;

const safeName = (value) => value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "state";

async function settle(page) {
  await page.waitForTimeout(320);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      return;
    } catch (error) {
      if (!/Execution context was destroyed/i.test(String(error))) throw error;
      await page.waitForLoadState("domcontentloaded").catch(() => {});
    }
  }
}

async function capture(page, name) {
  await settle(page);
  const file = path.join(output, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  // 若主区是内部滚动容器且内容超高，补一张滚到底部的视口截图（用户实际看到的底部）。
  const scrollable = await page.evaluate(() => {
    const main = document.querySelector("main, .main");
    return main && main.scrollHeight > main.clientHeight + 40 ? { scrollHeight: main.scrollHeight } : null;
  }).catch(() => null);
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
    await page.waitForTimeout(120);
  }
  console.log(`captured ${name}`);
}

async function currentButtons(page) {
  return page.locator(".main button:visible").evaluateAll((buttons) => buttons.map((button, index) => {
    const text = (button.textContent || "").replace(/\s+/g, " ").trim();
    return {
      index,
      text,
      disabled: button.disabled || button.getAttribute("aria-disabled") === "true",
      workflowNavigation: Boolean(button.closest(".step-indicator, [aria-label='任务步骤']")),
      picker: button.matches(".file-drop-zone") || /拖放|选择.*(?:文件|目录|文件夹|借款台账)|添加文件/.test(text),
    };
  }));
}

async function dismissJobOverlay(page) {
  const confirm = page.locator(".confirm-dialog:visible");
  if (await confirm.count()) {
    const actions = confirm.locator("button:visible");
    if (await actions.count()) {
      const labels = await actions.allTextContents();
      const confirmButton = labels.find((label) => /确认|确定|继续/.test(label));
      const target = confirmButton ? actions.nth(labels.indexOf(confirmButton)) : actions.last();
      await target.click();
      await settle(page);
      // 确认弹层关闭后任务弹窗可能弹出，截一张再最小化。
      const dialog = page.locator(".job-dialog:visible");
      if (await dialog.count()) {
        await page.screenshot({ path: path.join(output, "job-dialog-live.png") });
        console.log("captured job-dialog-live");
        const minimize = dialog.getByRole("button", { name: "最小化" });
        if (await minimize.count()) await minimize.click();
        await page.waitForTimeout(200);
      }
    }
  }
  const dialog = page.locator(".job-dialog:visible");
  if (!(await dialog.count())) return;
  const finished = await dialog.waitFor({ state: "hidden", timeout: 2500 }).then(() => true, () => false);
  if (finished) return;
  const minimize = dialog.getByRole("button", { name: "最小化" });
  if (await minimize.count()) await minimize.click();
  await page.waitForTimeout(150);
}

async function activatePickers(page) {
  const clicked = [];
  for (let pass = 0; pass < 5; pass += 1) {
    const buttons = await currentButtons(page);
    const candidate = buttons.find((button) => !button.disabled && !button.workflowNavigation && button.picker &&
      !clicked.includes(button.text));
    if (!candidate) break;
    await page.locator(".main button:visible").nth(candidate.index).click();
    clicked.push(candidate.text);
    await settle(page);
    await dismissJobOverlay(page);
  }
  return clicked;
}

async function advanceWorkflow(page, toolId, tag) {
  const seen = new Set();
  for (let step = 0; step < 8; step += 1) {
    await dismissJobOverlay(page);
    const buttons = await currentButtons(page);
    const candidates = buttons.filter((button) => !button.disabled && !button.workflowNavigation &&
      progressPattern.test(button.text) && !unsafePattern.test(button.text) && !/^\d/.test(button.text));
    const candidate = candidates.find((button) => !seen.has(button.text));
    if (!candidate) break;
    seen.add(candidate.text);
    await page.locator(".main button:visible").nth(candidate.index).evaluate((button) => button.click());
    await page.waitForTimeout(/(?:读取|检查|加载|开始|识别)/.test(candidate.text) ? 1400 : 500);
    await dismissJobOverlay(page);
    await capture(page, `${tag}-step${step + 1}-${safeName(candidate.text)}`);
  }
}

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-proxy-server"] });
  try {
    for (const viewport of viewports) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        reducedMotion: "reduce",
        deviceScaleFactor: 1,
      });
      const page = await context.newPage();
      await page.addInitScript(() => {
        localStorage.setItem("audit-toolbox.newbie-mode", "0");
        localStorage.setItem("audit-toolbox.newbie-tour.v2", JSON.stringify({ newbieMode: false, workspaceDone: true }));
        localStorage.setItem("audit-toolbox.demo-data", "1");
      });
      const suffix = viewport.label === "1600" ? "" : `@${viewport.label}`;
      const tag = (value) => `${value}${suffix}`;

      // 壳页面
      for (const route of ["/", "/history", "/settings"]) {
        await page.goto(`${baseUrl}/#${route}`, { waitUntil: "domcontentloaded" });
        await page.locator(".page-header:visible").first().waitFor({ timeout: 15000 }).catch(() => {});
        await settle(page);
        await capture(page, tag(route === "/" ? "shell-workspace" : `shell${route.replaceAll("/", "_")}`));
      }

      for (const tool of catalog) {
        const only = narrowRoutes.has(tool.route);
        if (viewport.label !== "1600" && !only) continue;
        console.log(`driving ${tool.id} @${viewport.label}`);
        const base = tag(`${tool.id}`);
        try {
          await page.goto(`${baseUrl}/#${tool.route}`, { waitUntil: "domcontentloaded" });
          await page.locator(".page-header:visible").first().waitFor({ timeout: 15000 }).catch(() => {});
          await settle(page);
          await capture(page, `${base}-initial`);

          if (tool.id === "audipick") continue; // AudiPick 单独窗口流程，本轮只看初始页
          const pickers = await activatePickers(page);
          if (pickers.length) {
            await page.waitForTimeout(1100);
            await dismissJobOverlay(page);
            await capture(page, `${base}-files-selected`);
          }
          await advanceWorkflow(page, tool.id, base);

          if (tool.id === "fa_list") {
            const accountReview = page.getByRole("button", { name: "复核科目分类" });
            if (await accountReview.isEnabled().catch(() => false)) {
              await accountReview.click();
              await settle(page);
              await capture(page, `${base}-account-review`);
              await advanceWorkflow(page, tool.id, `${base}-review`);
            }
            const cardsTab = page.getByRole("tab", { name: "两期固定资产清单" });
            if (await cardsTab.count()) {
              await cardsTab.click();
              await settle(page);
              await capture(page, `${base}-cards-initial`);
              const cardPickers = await activatePickers(page);
              if (cardPickers.length) {
                await page.waitForTimeout(900);
                await capture(page, `${base}-cards-files-selected`);
              }
              await advanceWorkflow(page, tool.id, `${base}-cards`);
            }
          }
        } catch (error) {
          console.log(`WARN ${tool.id}: ${String(error).slice(0, 200)}`);
        }
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
  console.log("DONE pages");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
