const { chromium } = require("playwright-core");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Run against `npm run dev -- --host 127.0.0.1`.
const baseUrl = process.env.OVERLAY_AUDIT_URL || "http://127.0.0.1:1420";
const viewports = [
  { width: 1280, height: 720, label: "1280x720" },
  { width: 1000, height: 720, label: "1000x720" },
  { width: 854, height: 720, label: "854x720" },
  { width: 1000, height: 480, label: "1000x480-high-content" },
];
const scenarios = [
  "confirm", "sync", "job-single", "job-multi", "tour",
  "step", "success", "jargon", "fuzzy", "job-success-stack",
  "step-confirm-stack", "jargon-confirm-stack",
];

const auditOverlay = () => {
  const issues = [];
  const visible = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  };
  const selector = (element) => {
    if (element.id) return `#${element.id}`;
    const classes = String(element.className || "").split(/\s+/).filter(Boolean).slice(0, 3).join(".");
    return `${element.tagName.toLowerCase()}${classes ? `.${classes}` : ""}`;
  };
  const roots = [...document.querySelectorAll(
    '[role="dialog"], .step-hint, .success-nudge, [role="tooltip"], .job-dialog-pill, .settings-update-panel',
  )].filter(visible);
  if (!roots.length) issues.push("missing visible overlay root");

  for (const root of roots) {
    const box = root.getBoundingClientRect();
    if (box.left < -2 || box.top < -2 || box.right > innerWidth + 2 || box.bottom > innerHeight + 2) {
      issues.push(`${selector(root)} outside viewport ${Math.round(box.left)},${Math.round(box.top)},${Math.round(box.right)},${Math.round(box.bottom)}`);
    }
    if (root.scrollWidth > root.clientWidth + 2 && !/(auto|scroll)/.test(getComputedStyle(root).overflowX)) {
      issues.push(`${selector(root)} clips horizontal content ${root.scrollWidth}/${root.clientWidth}`);
    }
    if (root.scrollHeight > root.clientHeight + 2 && !/(auto|scroll)/.test(getComputedStyle(root).overflowY)) {
      issues.push(`${selector(root)} clips vertical content ${root.scrollHeight}/${root.clientHeight}`);
    }
    for (const element of root.querySelectorAll("button,a[href],input,select,textarea,[tabindex='0']")) {
      if (!visible(element)) continue;
      const rect = element.getBoundingClientRect();
      let cursor = element.parentElement;
      let verticallyScrollable = /(auto|scroll)/.test(getComputedStyle(root).overflowY);
      while (cursor && cursor !== root) {
        if (/(auto|scroll)/.test(getComputedStyle(cursor).overflowY)) verticallyScrollable = true;
        cursor = cursor.parentElement;
      }
      const outsideHorizontally = rect.left < box.left - 2 || rect.right > box.right + 2;
      const outsideVertically = rect.top < box.top - 2 || rect.bottom > box.bottom + 2;
      if (outsideHorizontally || (outsideVertically && !verticallyScrollable)) {
        issues.push(`${selector(element)} outside ${selector(root)}`);
      }
      const label = element.closest("label");
      const target = label && root.contains(label) ? label.getBoundingClientRect() : rect;
      if (target.width < 24 || target.height < 24) {
        issues.push(`${selector(element)} target below 24px (${Math.round(target.width)}x${Math.round(target.height)})`);
      }
    }
  }

  for (const dialog of document.querySelectorAll('[role="dialog"][aria-modal="true"]')) {
    if (!visible(dialog)) continue;
    if (!(document.activeElement instanceof HTMLElement) || !dialog.contains(document.activeElement)) {
      issues.push(`${selector(dialog)} does not own focus`);
    }
  }

  const modal = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].find(visible);
  if (modal) {
    const modalZ = Number.parseInt(getComputedStyle(modal).zIndex, 10) || 0;
    for (const lower of document.querySelectorAll(".success-nudge,.step-hint,.job-dialog-pill,[role='tooltip']")) {
      if (!visible(lower) || modal.contains(lower)) continue;
      const lowerZ = Number.parseInt(getComputedStyle(lower).zIndex, 10) || 0;
      if (lowerZ >= modalZ) issues.push(`${selector(lower)} z-index ${lowerZ} competes with modal ${modalZ}`);
    }
  }
  return [...new Set(issues)];
};

(async () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "toolbox-overlay-layout-"));
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-proxy-server"] });
  const failures = [];
  let cases = 0;
  try {
    for (const viewport of viewports) {
      const { width, height, label } = viewport;
      const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce" });
      const page = await context.newPage();
      page.setDefaultTimeout(120000);
      await page.addInitScript(() => {
        const scenario = new URLSearchParams(location.search).get("overlay-fixture");
        localStorage.setItem(
          "audit-toolbox.newbie-tour.v2",
          JSON.stringify({ newbieMode: scenario === "step" || scenario === "success", workspaceDone: true }),
        );
        localStorage.setItem("audit-toolbox.demo-data", "1");
      });
      for (const scenario of scenarios) {
        cases += 1;
        await page.goto(`${baseUrl}/?overlay-fixture=${scenario}`, { waitUntil: "commit", timeout: 120000 });
        await page.locator(".overlay-state-fixture").waitFor();
        if (scenario === "jargon") await page.getByRole("button", { name: /^什么是/ }).focus();
        const expected = scenario === "success"
          ? ".success-nudge"
          : scenario === "jargon"
            ? '[role="tooltip"]'
            : scenario === "step"
              ? ".step-hint"
            : '[role="dialog"]';
        await page.locator(expected).waitFor();
        await page.evaluate(async () => {
          await document.fonts.ready;
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        });
        const issues = await page.evaluate(auditOverlay);

        if (scenario === "job-single" || scenario === "job-multi" || scenario === "job-success-stack") {
          await page.keyboard.press("Escape");
          if (!(await page.locator(".job-dialog").isVisible())) issues.push("job dialog closed with Escape");
          await page.getByRole("button", { name: "最小化" }).click();
          await page.locator(".job-dialog-pill").waitFor();
          issues.push(...await page.evaluate(auditOverlay));
          const pillFocused = await page.locator(".job-dialog-pill").evaluate((element) => element === document.activeElement);
          if (!pillFocused) issues.push("minimized job pill did not receive focus");
        }

        if (scenario === "confirm" || scenario === "fuzzy") {
          const cancelName = scenario === "confirm" ? "取消" : "取消";
          await page.getByRole("button", { name: cancelName, exact: true }).click();
          const trigger = page.locator(`[data-fixture-return-focus="${scenario}"]`);
          const focusReturned = await page.waitForFunction(
            (selector) => document.activeElement === document.querySelector(selector),
            `[data-fixture-return-focus="${scenario}"]`,
            { timeout: 1000 },
          ).then(() => true, () => false);
          if (!focusReturned) {
            issues.push(`${scenario} did not restore focus to its trigger`);
          }
        }

        if (issues.length) {
          failures.push({ viewport: label, scenario, issues: [...new Set(issues)] });
          await page.screenshot({ path: path.join(output, `${scenario}-${label}.png`), fullPage: true });
        }
      }

      // Real application drawer state (the rail exists below 1180 CSS px).
      if (width < 1180) {
        cases += 1;
        await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
        await page.locator(".sidebar-rail-menu").waitFor();
        await page.locator(".sidebar-rail-menu").click();
        await page.locator("#app-sidebar.drawer-open").waitFor();
        const issues = await page.evaluate(auditOverlay);
        const mainInert = await page.locator("#main-content").evaluate((element) => element.inert);
        if (!mainInert) issues.push("drawer background is not inert");
        await page.keyboard.press("Escape");
        const drawerTriggerFocused = await page.waitForFunction(
          () => document.activeElement === document.querySelector(".sidebar-rail-menu"),
          undefined,
          { timeout: 1000 },
        ).then(() => true, () => false);
        if (!drawerTriggerFocused) issues.push("drawer did not restore focus to menu trigger");
        if (issues.length) failures.push({ viewport: label, scenario: "drawer", issues });
      }

      // Real settings update panel: it opens synchronously before the network check resolves.
      cases += 1;
      await page.goto(`${baseUrl}/#/settings`, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: /软件更新|发现新版本/ }).click();
      await page.locator("#settings-update-panel").waitFor();
      const updateIssues = await page.evaluate(auditOverlay);
      await page.getByRole("button", { name: "收起" }).click();
      const updateTriggerFocused = await page.getByRole("button", { name: /软件更新|发现新版本/ }).evaluate((element) => element === document.activeElement);
      if (!updateTriggerFocused) updateIssues.push("settings update panel did not restore focus to trigger");
      if (updateIssues.length) failures.push({ viewport: label, scenario: "settings-update", issues: updateIssues });
      await context.close();
    }
  } finally {
    await browser.close();
  }
  const report = { cases, failureCount: failures.length, failures };
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, ...report }, null, 2));
  if (failures.length) process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
