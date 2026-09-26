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
  .filter((tool) => tool.id !== "audipick")
  .filter((tool) => !requestedRoutes.size || requestedRoutes.has(tool.id) || requestedRoutes.has(tool.route));
const desiredTaskStates = [
  "loading", "queued", "running", "paused", "cancelled",
  "failed", "completed", "partial", "restored", "history_resume",
];
const requestedViewports = new Set((process.env.WORKFLOW_AUDIT_VIEWPORTS || "")
  .split(",").map((value) => value.trim()).filter(Boolean));
const viewports = [
  { width: 1600, height: 900, label: "1600-wide" },
  { width: 1180, height: 760, label: "1180-shell-boundary" },
  { width: 1000, height: 680, label: "1000-minimum" },
].filter((viewport) => !requestedViewports.size || requestedViewports.has(String(viewport.width)) ||
  requestedViewports.has(viewport.label));
const output = process.env.WORKFLOW_AUDIT_OUTPUT
  ? path.resolve(process.env.WORKFLOW_AUDIT_OUTPUT)
  : fs.mkdtempSync(path.join(os.tmpdir(), "toolbox-workflow-layout-"));
fs.mkdirSync(output, { recursive: true });

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
    const horizontalScrollAncestor = [...function* ancestors(node) {
      for (let parent = node.parentElement; parent && parent !== root; parent = parent.parentElement) yield parent;
    }(element)].find((parent) => /(auto|scroll)/.test(getComputedStyle(parent).overflowX));
    if (scrollX && !/(auto|scroll)/.test(style.overflowX) && style.textOverflow !== "ellipsis" &&
      !horizontalScrollAncestor && !["TABLE", "THEAD", "TBODY", "TR"].includes(element.tagName)) {
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
      return child.tagName !== "COLGROUP" &&
        !["absolute", "fixed", "sticky"].includes(childStyle.position) && childStyle.float === "none" &&
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

  /*
   * Proportion contracts: overflow-only checks cannot find the most common
   * “looks broken” regressions (content-driven sibling columns, one-character
   * table wrapping, or compact controls stretched to card width).
   */
  for (const grid of root.querySelectorAll(".fa-tbje-pivot-grid")) {
    const tables = [...grid.querySelectorAll(":scope .fa-tbje-pivot-preview")].filter(visible);
    if (tables.length < 2) continue;
    const reference = [...tables[0].querySelectorAll("thead th")].map((cell) => box(cell).width);
    for (const table of tables.slice(1)) {
      const widths = [...table.querySelectorAll("thead th")].map((cell) => box(cell).width);
      const mismatch = reference.some((width, index) => Math.abs(width - (widths[index] ?? 0)) > 6);
      if (mismatch) {
        add("parallel-table-column-mismatch", table, {
          reference: reference.map(round),
          actual: widths.map(round),
        });
      }
    }
  }

  for (const grid of root.querySelectorAll(".fx-source-grid, .fuzzy-sources")) {
    const cards = [...grid.children].filter(visible);
    if (cards.length !== 2 || Math.abs(box(cards[0]).top - box(cards[1]).top) > 4) continue;
    const controls = cards.map((card) => [...card.querySelectorAll(
      ".fx-source-meta label select, .fx-source-meta label input, .fuzzy-source-meta label select, .fuzzy-source-meta label input",
    )].filter(visible));
    if (controls[0].length < 2 || controls[0].length !== controls[1].length) continue;
    const reference = controls[0].map((control) => box(control).width);
    const actual = controls[1].map((control) => box(control).width);
    if (reference.some((width, index) => Math.abs(width - actual[index]) > 6)) {
      add("parallel-source-control-mismatch", grid, {
        reference: reference.map(round), actual: actual.map(round),
      });
    }
  }

  for (const cell of root.querySelectorAll("table th, table td")) {
    if (!visible(cell) || cell.colSpan > 1) continue;
    const text = (cell.textContent || "").replace(/\s+/g, "").trim();
    if (text.length < 2 || text.length > 8 || !/[\u3400-\u9fff]/.test(text)) continue;
    const style = getComputedStyle(cell);
    const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.5;
    const rect = box(cell);
    if (rect.width < 56 && rect.height > lineHeight * 2.35) {
      add("vertical-table-label-wrap", cell, {
        text,
        width: round(rect.width),
        height: round(rect.height),
        lineHeight: round(lineHeight),
      });
    }
  }

  for (const control of root.querySelectorAll(
    ".form-grid > .field > input, .form-grid > .field > select",
  )) {
    if (!visible(control)) continue;
    const width = box(control).width;
    if (width > 430) add("stretched-standard-control", control, { width: round(width), limit: 420 });
  }

  for (const button of root.querySelectorAll(".fx-review-all > button, .dep-export-actions button")) {
    if (!visible(button)) continue;
    const width = box(button).width;
    if (width > 420) add("stretched-compact-action", button, { width: round(width), limit: 420 });
  }

  return issues;
};

const normalize = (value) => value.replace(/\s+/g, " ").trim();
const progressPattern = /^(?:读取|检查|加载|继续|下一步|开始|扫描|重新扫描|识别|运行前检查|结转|处理全部公司|筛选预览|套用审计关注|按一级科目)/;
const unsafePattern = /^(?:清空|删除|停止|取消|返回|导出|生成|保存|恢复默认)/;

async function currentButtons(page) {
  return page.locator(".main button:visible").evaluateAll((buttons) => buttons.map((button, index) => {
    const rect = button.getBoundingClientRect();
    return {
      index,
      text: (button.textContent || "").replace(/\s+/g, " ").trim(),
      disabled: button.disabled || button.getAttribute("aria-disabled") === "true",
      workflowNavigation: Boolean(button.closest(".step-indicator, [aria-label='任务步骤']")),
      picker: button.matches(".file-drop-zone") || /拖放|选择.*(?:文件|目录|文件夹|借款台账)|添加文件/.test(
        (button.textContent || "").replace(/\s+/g, " ").trim()),
      rect: { top: Math.round(rect.top), bottom: Math.round(rect.bottom), left: Math.round(rect.left), right: Math.round(rect.right) },
    };
  }));
}

async function waitForTaskOverlay(page) {
  const confirm = page.locator(".confirm-dialog:visible");
  if (await confirm.count()) {
    const actions = confirm.locator("button:visible");
    if (await actions.count()) {
      await actions.last().click();
      await settle(page);
    }
  }
  const dialog = page.locator(".job-dialog:visible");
  if (!(await dialog.count())) return;
  const finished = await dialog.waitFor({ state: "hidden", timeout: 2_500 })
    .then(() => true, () => false);
  if (finished) return;
  const minimize = dialog.getByRole("button", { name: "最小化" });
  if (await minimize.count()) await minimize.click();
}

async function settle(page) {
  await page.waitForTimeout(260);
  await evaluateStable(page, async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function evaluateStable(page, callback, argument) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await page.evaluate(callback, argument);
    } catch (error) {
      if (!/Execution context was destroyed|Cannot find context/i.test(String(error)) || attempt === 2) throw error;
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForTimeout(300);
    }
  }
}

async function captureState(page, tool, viewport, stateLabel, results) {
  const positions = await evaluateStable(page, () => {
    const root = document.querySelector("main, .main");
    const scrollOwner = root && root.scrollHeight > root.clientHeight + 1
      ? root
      : document.scrollingElement;
    const max = Math.max(0, (scrollOwner?.scrollHeight ?? 0) - (scrollOwner?.clientHeight ?? innerHeight));
    return [...new Set([0, Math.round(max / 2), max])];
  });
  for (const [positionIndex, position] of positions.entries()) {
    await evaluateStable(page, (top) => {
      const root = document.querySelector("main, .main");
      const scrollOwner = root && root.scrollHeight > root.clientHeight + 1
        ? root
        : document.scrollingElement;
      scrollOwner?.scrollTo({ top, behavior: "instant" });
    }, position);
    await settle(page);
    const issues = await evaluateStable(page, auditGeometry);
    const observedTaskStates = await evaluateStable(page, () => {
      const visible = (element) => element.getClientRects().length > 0 &&
        getComputedStyle(element).visibility !== "hidden";
      const states = [...document.querySelectorAll(".main [data-job-state]")]
        .filter(visible).map((element) => element.getAttribute("data-job-state"));
      if ([...document.querySelectorAll(".job-dialog, .job-dialog-pill")].some(visible)) {
        states.push("running");
      }
      return [...new Set(states.filter(Boolean))];
    });
    const record = {
      viewport: viewport.label,
      route: tool.route,
      state: stateLabel,
      scroll: ["top", "middle", "bottom"][positionIndex] || String(positionIndex),
      observedTaskStates,
      issues,
    };
    results.push(record);
    if (issues.length || process.env.WORKFLOW_AUDIT_CAPTURE_ALL === "1") {
      const fileName = `${viewport.label}-${tool.id}-${stateLabel}-${record.scroll}`.replace(/[^a-zA-Z0-9._-]+/g, "_");
      await page.screenshot({ path: path.join(output, `${fileName}.png`) });
    }
  }
  await evaluateStable(page, () => {
    const root = document.querySelector("main, .main");
    const scrollOwner = root && root.scrollHeight > root.clientHeight + 1
      ? root
      : document.scrollingElement;
    scrollOwner?.scrollTo({ top: 0, behavior: "instant" });
  });
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
    await waitForTaskOverlay(page);
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

async function prepareRoute(page, tool, viewport, results) {
  if (tool.id !== "audit_roll_forward") return;
  const create = page.getByRole("button", { name: "新建项目", exact: true });
  if (!(await create.count())) return;
  await create.click();
  await settle(page);
  await captureState(page, tool, viewport, "project-created", results);
  const browseButtons = page.getByRole("button", { name: "浏览", exact: true });
  const browseCount = await browseButtons.count();
  for (let index = 0; index < browseCount; index += 1) {
    await browseButtons.nth(index).click();
    await settle(page);
  }
  const selectAll = page.getByRole("button", { name: "全选科目", exact: true });
  if (await selectAll.count()) await selectAll.click();
  await settle(page);
  await captureState(page, tool, viewport, "project-configured", results);
}

async function advanceWorkflow(page, tool, viewport, results) {
  const seen = new Set();
  for (let step = 0; step < 7; step += 1) {
    await waitForTaskOverlay(page);
    const buttons = await currentButtons(page);
    if (process.env.WORKFLOW_AUDIT_DEBUG) console.log("buttons", tool.id, buttons);
    const candidates = buttons.filter((button) => !button.disabled && !button.workflowNavigation && progressPattern.test(button.text) &&
      !unsafePattern.test(button.text) && !/^\d/.test(button.text));
    const candidate = candidates.find((button) => !seen.has(button.text));
    if (!candidate) break;
    seen.add(candidate.text);
    await page.locator(".main button:visible").nth(candidate.index).evaluate((button) => button.click());
    await page.waitForTimeout(/(?:读取|检查|加载|开始)/.test(candidate.text) ? 950 : 320);
    await waitForTaskOverlay(page);
    await settle(page);
    await captureState(page, tool, viewport, `step-${step + 1}-${normalize(candidate.text).slice(0, 24)}`, results);
  }
}

async function runWorkflowAudit() {
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
        await prepareRoute(page, tool, viewport, results);
        const pickers = await activatePickers(page);
        if (pickers.length) {
          await page.waitForTimeout(900);
          await completeRequiredSelects(page, tool);
          await captureState(page, tool, viewport, "files-selected", results);
        }
        await advanceWorkflow(page, tool, viewport, results);
        if (tool.id === "fa_list") {
          const accountReview = page.getByRole("button", { name: "复核科目分类" });
          if (await accountReview.isEnabled().catch(() => false)) {
            await accountReview.click();
            await settle(page);
            await captureState(page, tool, viewport, "fa-tbje-account-review", results);
            await advanceWorkflow(page, tool, viewport, results);
          }
          const cardsTab = page.getByRole("tab", { name: "两期固定资产清单" });
          await cardsTab.click();
          await settle(page);
          await captureState(page, tool, viewport, "fa-cards-initial", results);
          const cardPickers = await activatePickers(page);
          if (cardPickers.length) {
            await page.waitForTimeout(900);
            await captureState(page, tool, viewport, "fa-cards-files-selected", results);
          }
          await advanceWorkflow(page, tool, viewport, results);
        }
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(results, null, 2));
  const failures = results.filter((result) => result.issues.length);
  const observedByTool = Object.fromEntries(catalog.map((tool) => {
    const observed = [...new Set(results
      .filter((result) => result.route === tool.route)
      .flatMap((result) => result.observedTaskStates))];
    return [tool.id, {
      observed,
      unverified: desiredTaskStates.filter((state) => !observed.includes(state)),
    }];
  }));
  fs.writeFileSync(path.join(output, "coverage.json"), JSON.stringify({
    coverageKind: "real-pages-positive-path-only",
    excludedToolIds: ["audipick"],
    taskEventMatrixComplete: false,
    observedByTool,
  }, null, 2));
  console.log(JSON.stringify({
    output,
    coverageKind: "real-pages-positive-path-only",
    taskEventMatrixComplete: false,
    coverageFile: path.join(output, "coverage.json"),
    snapshots: results.length,
    failures: failures.length,
    summary: failures.slice(0, 120),
  }, null, 2));
  if (failures.length) process.exitCode = 1;
}

module.exports = {
  auditGeometry,
  currentButtons,
  activatePickers,
  completeRequiredSelects,
  settle,
  progressPattern,
  unsafePattern,
};

if (require.main === module) {
  runWorkflowAudit().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
