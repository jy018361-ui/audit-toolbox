const { chromium } = require("playwright-core");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/*
 * Real-page workflow geometry gate.
 *
 * Unlike the static gate, this opens every tool with preview data, activates
 * its file pickers and advances through enabled workflow actions. Every state
 * is checked at the top, middle and bottom of the page so a short companion
 * column cannot leave a large blank strip unnoticed during scrolling.
 */
const baseUrl = process.env.WORKFLOW_AUDIT_URL || "http://127.0.0.1:1422";
const requestedRoutes = new Set((process.env.WORKFLOW_AUDIT_ROUTES || "")
  .split(",").map((value) => value.trim()).filter(Boolean));
const catalog = JSON.parse(fs.readFileSync("public/tool-catalog.json", "utf8"))
  .filter((tool) => !requestedRoutes.size || requestedRoutes.has(tool.id) || requestedRoutes.has(tool.route));
const requestedViewports = new Set((process.env.WORKFLOW_AUDIT_VIEWPORTS || "")
  .split(",").map((value) => value.trim()).filter(Boolean));
const viewports = [
  { width: 1600, height: 900, label: "1600-wide" },
  { width: 1180, height: 760, label: "1180-shell-boundary" },
  { width: 1000, height: 680, label: "1000-minimum" },
].filter((viewport) => !requestedViewports.size || requestedViewports.has(String(viewport.width)) ||
  requestedViewports.has(viewport.label));
const output = fs.mkdtempSync(path.join(os.tmpdir(), "toolbox-workflow-layout-"));

const auditGeometry = () => {
  const root = document.querySelector("main, .main");
  if (!root) return [{ kind: "missing-main", selector: "body" }];
  const issues = [];
  const visible = (element) => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && style.display !== "none" &&
      style.visibility !== "hidden" && !element.matches(".sr-only") &&
      !element.closest("[hidden], [inert], [role=dialog], .dialog-overlay");
  };
  const elements = [...root.querySelectorAll("*")].filter(visible);
  const box = (element) => element.getBoundingClientRect();
  const round = (value) => Math.round(value * 10) / 10;
  const selector = (element) => {
    if (element.id) return `#${element.id}`;
    const classes = [...element.classList].slice(0, 3).join(".");
    return `${element.tagName.toLowerCase()}${classes ? `.${classes}` : ""}`;
  };
  const add = (kind, element, detail) => issues.push({ kind, selector: selector(element), detail });

  if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) {
    add("page-overflow", root, {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    });
  }

  for (const element of elements) {
    const style = getComputedStyle(element);
    const rect = box(element);
    const scrollX = element.scrollWidth > element.clientWidth + 2;
    if (scrollX && !/(auto|scroll)/.test(style.overflowX) && style.textOverflow !== "ellipsis" &&
      !["TABLE", "THEAD", "TBODY", "TR"].includes(element.tagName)) {
      add("child-overflow-x", element, {
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        overflowX: style.overflowX,
      });
    }
    if (/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(element.tagName)) {
      const main = box(root);
      const scrollOwner = [...function* ancestors(node) {
        for (let parent = node.parentElement; parent && parent !== root; parent = parent.parentElement) yield parent;
      }(element)].find((parent) => /(auto|scroll)/.test(getComputedStyle(parent).overflowX));
      if (!scrollOwner && (rect.left < main.left - 1 || rect.right > main.right + 1)) {
        add("control-outside-main", element, {
          left: round(rect.left), right: round(rect.right),
          mainLeft: round(main.left), mainRight: round(main.right),
        });
      }
    }
  }

  for (const parent of [root, ...elements]) {
    const style = getComputedStyle(parent);
    if (["contents", "inline"].includes(style.display) || parent.closest("svg, .theme-option-swatches")) continue;
    const children = [...parent.children].filter(visible).filter((child) => {
      const childStyle = getComputedStyle(child);
      return !["absolute", "fixed", "sticky"].includes(childStyle.position) && childStyle.float === "none" &&
        !["inline", "inline-block", "inline-flex", "inline-grid"].includes(childStyle.display);
    });
    for (let index = 0; index < children.length; index += 1) {
      const first = box(children[index]);
      for (let other = index + 1; other < children.length; other += 1) {
        const second = box(children[other]);
        const overlapX = Math.min(first.right, second.right) - Math.max(first.left, second.left);
        const overlapY = Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top);
        if (overlapX > 2 && overlapY > 2) {
          add("sibling-overlap", children[other], {
            with: selector(children[index]), overlapX: round(overlapX), overlapY: round(overlapY),
            parent: selector(parent),
          });
        }
      }
    }
  }

  for (const parent of elements) {
    const style = getComputedStyle(parent);
    if (!/(grid|flex)/.test(style.display)) continue;
    const children = [...parent.children].filter(visible).filter((child) =>
      !["absolute", "fixed", "sticky"].includes(getComputedStyle(child).position));
    if (children.length !== 2) continue;
    const [first, second] = children.map(box);
    const sideBySide = Math.abs(first.top - second.top) <= 4 && first.right <= second.left + 2;
    const tall = Math.max(first.height, second.height);
    const short = Math.min(first.height, second.height);
    const parentWidth = box(parent).width;
    const narrowCompanion = Math.min(first.width, second.width) >= parentWidth * 0.2;
    if (sideBySide && narrowCompanion && tall >= 680 && short <= 380 && tall / Math.max(short, 1) >= 2.35) {
      add("imbalanced-workspace-columns", parent, {
        firstHeight: round(first.height), secondHeight: round(second.height), ratio: round(tall / short),
      });
    }
  }

  return issues;
};

const normalize = (value) => value.replace(/\s+/g, " ").trim();
const progressPattern = /^(?:读取|检查|加载|继续|下一步|开始|重新扫描|筛选预览|套用审计关注|按一级科目)/;
const unsafePattern = /^(?:清空|删除|停止|取消|返回|导出|生成|保存|恢复默认)/;

async function currentButtons(page) {
  return page.locator(".main button:visible").evaluateAll((buttons) => buttons.map((button, index) => ({
    index,
    text: (button.textContent || "").replace(/\s+/g, " ").trim(),
    disabled: button.disabled || button.getAttribute("aria-disabled") === "true",
    workflowNavigation: Boolean(button.closest(".step-indicator, [aria-label='任务步骤']")),
    picker: button.matches(".file-drop-zone") || /拖放|选择.*(?:文件|目录|文件夹|借款台账)|添加文件|扫描文件夹/.test(
      (button.textContent || "").replace(/\s+/g, " ").trim()),
  })));
}

async function settle(page) {
  await page.waitForTimeout(260);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function captureState(page, tool, viewport, stateLabel, results) {
  const positions = await page.evaluate(() => {
    const max = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    return [...new Set([0, Math.round(max / 2), max])];
  });
  for (const [positionIndex, position] of positions.entries()) {
    await page.evaluate((top) => scrollTo({ top, behavior: "instant" }), position);
    await settle(page);
    const issues = await page.evaluate(auditGeometry);
    const record = {
      viewport: viewport.label,
      route: tool.route,
      state: stateLabel,
      scroll: ["top", "middle", "bottom"][positionIndex] || String(positionIndex),
      issues,
    };
    results.push(record);
    if (issues.length) {
      const fileName = `${viewport.label}-${tool.id}-${stateLabel}-${record.scroll}`.replace(/[^a-zA-Z0-9._-]+/g, "_");
      await page.screenshot({ path: path.join(output, `${fileName}.png`) });
    }
  }
  await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
}

async function activatePickers(page) {
  const clicked = [];
  for (let pass = 0; pass < 5; pass += 1) {
    const buttons = await currentButtons(page);
    const candidate = buttons.find((button) => !button.disabled && !button.workflowNavigation && button.picker &&
      !clicked.includes(button.text));
    if (!candidate) break;
    const locator = page.locator(".main button:visible").nth(candidate.index);
    await locator.click();
    clicked.push(candidate.text);
    await settle(page);
  }
  return clicked;
}

async function completeRequiredSelects(page, tool) {
  if (tool.id !== "fuzzy_match") return;
  const selects = page.locator(".main select:visible");
  for (let index = 0; index < await selects.count(); index += 1) {
    const select = selects.nth(index);
    const target = await select.evaluate((element) => {
      if (element.disabled || element.value) return "";
      return [...element.options].find((option) => option.value && !option.disabled)?.value || "";
    });
    if (target) await select.selectOption(target).catch(() => {});
  }
  await settle(page);
}

async function advanceWorkflow(page, tool, viewport, results) {
  const seen = new Set();
  for (let step = 0; step < 7; step += 1) {
    const buttons = await currentButtons(page);
    if (process.env.WORKFLOW_AUDIT_DEBUG) console.log("buttons", tool.id, buttons);
    const signature = buttons.map((button) => `${button.disabled ? "0" : "1"}:${button.text}`).join("|");
    const candidates = buttons.filter((button) => !button.disabled && !button.workflowNavigation && progressPattern.test(button.text) &&
      !unsafePattern.test(button.text) && !/^\d/.test(button.text));
    const candidate = candidates.find((button) => !seen.has(`${signature}:${button.text}`));
    if (!candidate) break;
    seen.add(`${signature}:${candidate.text}`);
    await page.locator(".main button:visible").nth(candidate.index).click();
    await page.waitForTimeout(/(?:读取|检查|加载|开始)/.test(candidate.text) ? 950 : 320);
    await settle(page);
    await captureState(page, tool, viewport, `step-${step + 1}-${normalize(candidate.text).slice(0, 24)}`, results);
  }
}

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-proxy-server"] });
  const results = [];
  try {
    for (const viewport of viewports) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      await page.addInitScript(() => {
        localStorage.setItem("audit-toolbox.newbie-tour.v2", JSON.stringify({ newbieMode: false, workspaceDone: true }));
        localStorage.setItem("audit-toolbox.demo-data", "1");
      });
      for (const tool of catalog) {
        console.log(`Auditing ${viewport.label} ${tool.route}`);
        await page.goto(`${baseUrl}/#${tool.route}`, { waitUntil: "domcontentloaded" });
        await page.locator(".page-header:visible").first().waitFor({ timeout: 12_000 }).catch(() => {});
        await settle(page);
        await captureState(page, tool, viewport, "initial", results);
        const pickers = await activatePickers(page);
        if (pickers.length) {
          await page.waitForTimeout(900);
          await completeRequiredSelects(page, tool);
          await captureState(page, tool, viewport, "files-selected", results);
        }
        await advanceWorkflow(page, tool, viewport, results);
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(results, null, 2));
  const failures = results.filter((result) => result.issues.length);
  console.log(JSON.stringify({
    output,
    snapshots: results.length,
    failures: failures.length,
    summary: failures.slice(0, 120),
  }, null, 2));
  if (failures.length) process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
