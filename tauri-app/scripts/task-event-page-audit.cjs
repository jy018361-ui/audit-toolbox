const { chromium } = require("playwright-core");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  auditGeometry, currentButtons, activatePickers, completeRequiredSelects,
  settle,
} = require("./workflow-layout-audit.cjs");

const baseUrl = process.env.TASK_EVENT_AUDIT_URL || "http://127.0.0.1:1422";
const requestedRoutes = new Set((process.env.TASK_EVENT_AUDIT_ROUTES || "")
  .split(",").map((value) => value.trim()).filter(Boolean));
const requestedViewports = new Set((process.env.TASK_EVENT_AUDIT_VIEWPORTS || "")
  .split(",").map((value) => value.trim()).filter(Boolean));
const tools = JSON.parse(fs.readFileSync("public/tool-catalog.json", "utf8"))
  .filter((tool) => tool.id !== "audipick")
  .filter((tool) => !requestedRoutes.size || requestedRoutes.has(tool.id) || requestedRoutes.has(tool.route));
const viewports = [
  { width: 1600, height: 900 },
  { width: 1180, height: 760 },
  { width: 1000, height: 680 },
].filter(({ width }) => !requestedViewports.size || requestedViewports.has(String(width)));
const scenarios = [
  { name: "failed", phases: ["queued", "running", "failed"] },
  { name: "cancelled", phases: ["queued", "running", "cancelled"] },
  { name: "completed", phases: ["queued", "running", "completed"] },
].filter(({ name }) => !process.env.TASK_EVENT_AUDIT_SCENARIO || process.env.TASK_EVENT_AUDIT_SCENARIO === name);
const taskActionPattern = /(?:读取|检查|加载|继续|下一步|开始|扫描|重新扫描|识别|解析|运行|确认|保存|测算|计算|匹配|处理|筛选|生成|导出|结转|复核)/;
const skipActionPattern = /(?:清空|删除|停止|取消|返回|保存配置|恢复默认)/;
const preferredMethods = {
  fx_audit: ["fx.preview", "fx.export"],
  deposit_interest: ["deposit.preview", "deposit.export"],
  loan_interest: ["loan.preview", "loan.export"],
  fa_list: ["fa.match", "fa.export"],
  fa_dep_calc: ["fa.dep_export"],
  fa_policy_compare: ["fa.policy_export"],
};
const output = process.env.TASK_EVENT_AUDIT_OUTPUT
  ? path.resolve(process.env.TASK_EVENT_AUDIT_OUTPUT)
  : fs.mkdtempSync(path.join(os.tmpdir(), "toolbox-real-task-events-"));
fs.mkdirSync(output, { recursive: true });

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

async function replayJobs(page) {
  await page.waitForFunction(() => Boolean(window.__demoTaskReplay), null, { timeout: 10_000 });
  return evaluateStable(page, () => window.__demoTaskReplay?.jobs() ?? []);
}

async function findFirstJob(page, tool) {
  if (tool.id === "audit_roll_forward") {
    const create = page.getByRole("button", { name: "新建项目", exact: true });
    if (await create.count()) {
      await create.click();
      await settle(page);
      const browse = page.getByRole("button", { name: "浏览", exact: true });
      for (let index = 0; index < await browse.count(); index += 1) {
        await browse.nth(index).click();
        await settle(page);
      }
      const selectAll = page.getByRole("button", { name: "全选科目", exact: true });
      if (await selectAll.count()) await selectAll.click();
      await settle(page);
    }
  }
  await activatePickers(page);
  await completeRequiredSelects(page, tool);
  if (tool.id === "fa_list") {
    const cardsTab = page.getByRole("tab", { name: "两期固定资产清单" });
    if (await cardsTab.count()) {
      await cardsTab.click();
      await settle(page);
      await activatePickers(page);
    }
  }
  const seen = new Set();
  const preferred = preferredMethods[tool.id];
  const selectJob = (jobs) => preferred
    ? [...jobs].reverse().find((job) => preferred.includes(job.method))
    : jobs.at(-1);
  for (let step = 0; step < 14; step += 1) {
    const before = await replayJobs(page);
    const active = selectJob(before);
    if (active) return active;
    const buttons = await currentButtons(page);
    let candidate = buttons.find((button) => !button.disabled && !button.workflowNavigation &&
      taskActionPattern.test(button.text) && !skipActionPattern.test(button.text) &&
      !/^\d/.test(button.text) && !seen.has(button.text));
    if (!candidate) {
      // 多步骤账表页常把任务入口放在后续步骤；优先进入最靠后的可用步骤。
      candidate = [...buttons].reverse().find((button) => !button.disabled && button.workflowNavigation &&
        !seen.has(button.text));
    }
    if (!candidate) {
      if (process.env.TASK_EVENT_AUDIT_DEBUG) console.log("no-candidate", tool.id, buttons.map((button) => button.text));
      break;
    }
    seen.add(candidate.text);
    if (process.env.TASK_EVENT_AUDIT_DEBUG) console.log("click", tool.id, candidate.text);
    await page.locator(".main button:visible").nth(candidate.index).evaluate((button) => button.click());
    await settle(page);
    await completeRequiredSelects(page, tool);
    const confirm = page.locator(".confirm-dialog:visible");
    if (await confirm.count()) {
      const affirmative = confirm.getByRole("button", { name: /^(?:确认|继续|删除|清空|停止)$/ });
      if (await affirmative.count()) await affirmative.last().click();
      else await confirm.locator("button:visible").nth(-2).click();
      await settle(page);
    }
    if (/(?:开始结转|处理全部公司)/.test(candidate.text)) {
      await page.waitForTimeout(1_000);
    }
    if (process.env.TASK_EVENT_AUDIT_DEBUG) {
      console.log("after-click", tool.id, candidate.text, (await currentButtons(page)).map((button) => `${button.disabled ? "[disabled] " : ""}${button.text}`));
    }
  }
  if (process.env.TASK_EVENT_AUDIT_DEBUG) {
    console.log("page-errors", tool.id, await page.locator(".main .error-box:visible").allTextContents());
  }
  const jobs = await replayJobs(page);
  return selectJob(jobs);
}

async function capture(page, tool, viewport, scenario, phase, job, results) {
  await settle(page);
  const positions = await evaluateStable(page, () => {
    const root = document.querySelector("main, .main");
    const owner = root && root.scrollHeight > root.clientHeight + 1 ? root : document.scrollingElement;
    const max = Math.max(0, (owner?.scrollHeight || 0) - (owner?.clientHeight || innerHeight));
    return [...new Set([0, Math.round(max / 2), max])];
  });
  for (const [index, top] of positions.entries()) {
    await evaluateStable(page, (position) => {
      const root = document.querySelector("main, .main");
      const owner = root && root.scrollHeight > root.clientHeight + 1 ? root : document.scrollingElement;
      owner?.scrollTo({ top: position, behavior: "instant" });
    }, top);
    await settle(page);
    const issues = await evaluateStable(page, auditGeometry);
    const visibleState = await evaluateStable(page, () => {
      const visible = (element) => element.getClientRects().length > 0 &&
        getComputedStyle(element).visibility !== "hidden";
      const states = [...document.querySelectorAll(".main [data-job-state]")]
        .filter(visible).map((element) => element.getAttribute("data-job-state"));
      const dialog = [...document.querySelectorAll(".job-dialog, .job-dialog-pill")].some(visible);
      return { states: [...new Set(states.filter(Boolean))], dialog };
    });
    const record = {
      toolId: tool.id, route: tool.route, viewport: viewport.width,
      scenario, phase, scroll: ["top", "middle", "bottom"][index],
      jobId: job.jobId, method: job.method, visibleState, issues,
    };
    results.push(record);
    if (issues.length || process.env.TASK_EVENT_AUDIT_CAPTURE_ALL === "1" ||
      (process.env.TASK_EVENT_AUDIT_CAPTURE_TOP === "1" && index === 0 &&
        (phase === "running" || phase === scenario))) {
      const file = `${viewport.width}-${tool.id}-${scenario}-${phase}-${index}`
        .replace(/[^a-zA-Z0-9._-]+/g, "_");
      await page.screenshot({ path: path.join(output, `${file}.png`) });
    }
  }
}

(async () => {
  const headful = process.env.TASK_EVENT_AUDIT_HEADFUL === "1";
  const browser = await chromium.launch({
    channel: "chrome",
    headless: !headful,
    slowMo: headful ? Number(process.env.TASK_EVENT_AUDIT_SLOW_MO || 220) : 0,
    args: ["--no-proxy-server"],
  });
  const results = [];
  const coverage = [];
  try {
    for (const viewport of viewports) {
      for (const tool of tools) {
        for (const scenario of scenarios) {
          // 每个场景使用独立浏览器上下文，避免设置、任务和历史状态串到下一个工具。
          const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
          const page = await context.newPage();
          await page.addInitScript(() => {
            localStorage.setItem("audit-toolbox.demo-data", "1");
            localStorage.setItem("audit-toolbox.newbie-tour.v2", JSON.stringify({ newbieMode: false, workspaceDone: true }));
          });
          try {
          console.log(`Auditing ${viewport.width} ${tool.id} ${scenario.name}`);
          // Query nonce forces a full document reload so replay jobs from the previous
          // terminal scenario cannot leak into the next one on the same hash route.
          await page.goto(`${baseUrl}/?demo=1&taskAudit=${viewport.width}-${tool.id}-${scenario.name}#${tool.route}`,
            { waitUntil: "commit", timeout: 15_000 });
          await page.locator(".page-header:visible").first().waitFor({ timeout: 12_000 }).catch(() => {});
          const replayReady = await page.waitForFunction(() => Boolean(window.__demoTaskReplay), null, { timeout: 5_000 })
            .then(() => true, () => false);
          if (!replayReady) {
            coverage.push({ toolId: tool.id, viewport: viewport.width, scenario: scenario.name, status: "harness-unavailable" });
            continue;
          }
          await evaluateStable(page, () => window.__demoTaskReplay?.setAutoPlayback(false));
          const job = await findFirstJob(page, tool);
          if (!job) {
            coverage.push({ toolId: tool.id, viewport: viewport.width, scenario: scenario.name, status: "job-not-reached" });
            continue;
          }
          if (process.env.TASK_EVENT_AUDIT_DEBUG) console.log("selected-job", job);
          coverage.push({ toolId: tool.id, viewport: viewport.width, scenario: scenario.name, status: "injected", method: job.method });
          for (const phase of scenario.phases) {
            await page.waitForFunction(() => Boolean(window.__demoTaskReplay), null, { timeout: 10_000 });
            await evaluateStable(page, ({ id, next }) => window.__demoTaskReplay?.inject(id, next),
              { id: job.jobId, next: phase });
            await capture(page, tool, viewport, scenario.name, phase, job, results);
          }
          } finally {
            await context.close();
          }
        }
      }
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(output, "coverage.json"), JSON.stringify(coverage, null, 2));
  const failures = results.filter((record) => record.issues.length);
  const missing = coverage.filter((record) => record.status !== "injected");
  console.log(JSON.stringify({ output, snapshots: results.length, failures: failures.length,
    injectedScenarios: coverage.length - missing.length, missingScenarios: missing.length,
    failureSummary: failures.slice(0, 50), coverageGaps: missing.slice(0, 50) }, null, 2));
  if (failures.length || missing.length) process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
