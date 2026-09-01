import { chromium } from "playwright-core";
import { pathToFileURL } from "node:url";
import path from "node:path";

const root = process.cwd();
const prototypeDir = path.join(root, "artifacts", "fx-ui-redesign");
const files = [
  "direction-a-guide.html",
  "direction-b-workbench.html",
  "direction-c-checklist.html",
  "current-layout-optimized.html",
  "deposit-interest-optimized.html",
  "loan-interest-optimized.html",
];

const browser = await chromium.launch({
  executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  headless: true,
});

let failed = false;
for (const file of files) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(pathToFileURL(path.join(prototypeDir, file)).href, {
    waitUntil: "load",
  });
  await page.waitForTimeout(300);

  let interaction = {};
  if (file === "deposit-interest-optimized.html") {
    await page.click('.step[data-step="2"]');
    await page.waitForTimeout(120);
    interaction.step2Visible = await page.locator('.view[data-view="2"].active').isVisible();
    await page.locator('.rate-input input').first().focus();
    interaction.rateInputContained = await page.locator('.rate-input').first().evaluate((wrapper) => {
      const input = wrapper.querySelector('input');
      if (!input) return false;
      const inputRect = input.getBoundingClientRect();
      const wrapperRect = wrapper.getBoundingClientRect();
      return inputRect.left >= wrapperRect.left - 0.5 && inputRect.right <= wrapperRect.right + 0.5;
    });
    interaction.cardColumnsAligned = await page.evaluate(() => {
      const lefts = (selector) => Array.from(document.querySelectorAll(`${selector} .table-head > *`), (item) => item.getBoundingClientRect().left);
      const upper = lefts('.account-table');
      const lower = lefts('.rate-table');
      return upper.length === lower.length && upper.every((value, index) => Math.abs(value - lower[index]) <= 0.5);
    });
    await page.screenshot({
      path: path.join(prototypeDir, "deposit-interest-step2-1440.png"),
      fullPage: true,
    });

    await page.click('.step[data-step="3"]');
    await page.click('#previewBtn');
    await page.waitForTimeout(120);
    interaction.step3Visible = await page.locator('.view[data-view="3"].active').isVisible();
    interaction.resultVisible = await page.locator('#result.show').isVisible();
    interaction.resultStepCircles = (await page.locator('#result .result-label > b').count()) === 2;
    interaction.inventoryCashOptionRemoved = !(await page.locator('body').innerText()).includes('库存现金也计息');
    await page.screenshot({
      path: path.join(prototypeDir, "deposit-interest-step3-1440.png"),
      fullPage: true,
    });

    await page.click('.step[data-step="1"]');
  }
  if (file === "loan-interest-optimized.html") {
    await page.click('.mode[data-mode="tb"]');
    interaction.tbModeVisible = await page.locator('.mode-panel[data-mode-panel="tb"].active').isVisible();
    interaction.tbModeHasTwoSources = (await page.locator('.mode-panel[data-mode-panel="tb"] .source').count()) === 2;
    interaction.uploadCardsContainNoHeaderControls = (await page.locator('.source .source-controls').count()) === 0;
    interaction.headerRowIsCompact = await page.locator('.mapping-mode.active .compact-number').first().evaluate((input) => input.getBoundingClientRect().width <= 84);
    interaction.tbPreviewsVisible = (await page.locator('.mapping-mode.active .preview-block:visible').count()) === 2;
    interaction.previewUsesColumnMappings = (await page.locator('.mapping-mode.active .preview-table th .dt-header-control select').count()) === 9;
    interaction.previewSkeletonsRemoved = (await page.locator('.mapping-mode.active .skeleton').count()) === 0;
    interaction.previewStructureMetaRemoved = (await page.locator('.mapping-mode.active .collapse-title small:visible').count()) === 0;
    await page.click('.step[data-step="2"]');
    await page.waitForTimeout(120);
    interaction.step2Visible = await page.locator('.view[data-view="2"].active').isVisible();
    interaction.rateTableContained = await page.locator('.rate-table').evaluate((table) => table.scrollWidth <= table.clientWidth + 1);
    await page.screenshot({
      path: path.join(prototypeDir, "loan-interest-step2-1440.png"),
      fullPage: true,
    });
    await page.click('.step[data-step="3"]');
    await page.click('#previewBtn');
    await page.waitForTimeout(120);
    interaction.step3Visible = await page.locator('.view[data-view="3"].active').isVisible();
    interaction.resultVisible = await page.locator('#result.show').isVisible();
    interaction.resultStepCircles = (await page.locator('#result .result-label > b').count()) === 2;
    await page.screenshot({
      path: path.join(prototypeDir, "loan-interest-step3-1440.png"),
      fullPage: true,
    });
    await page.click('.step[data-step="1"]');
  }

  const metrics = await page.evaluate(() => ({
    title: document.title,
    bodyWidth: document.body.scrollWidth,
    viewportWidth: window.innerWidth,
    buttons: document.querySelectorAll("button").length,
    emptyText: (document.body.innerText || "").trim().length === 0,
  }));
  const screenshot = path.join(
    prototypeDir,
    file.replace(".html", "-1440.png"),
  );
  await page.screenshot({ path: screenshot, fullPage: true });
  await page.close();

  const overflow = metrics.bodyWidth > metrics.viewportWidth + 1;
  const interactionFailed = Object.values(interaction).some((value) => !value);
  if (errors.length || overflow || metrics.emptyText || interactionFailed) failed = true;
  console.log(JSON.stringify({ file, ...metrics, overflow, interaction, errors }));
}

await browser.close();
if (failed) process.exitCode = 1;
