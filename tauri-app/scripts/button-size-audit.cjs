const { chromium } = require('playwright-core');
const fs = require('node:fs');
const path = require('node:path');
const { auditButtonSizes } = require('./button-size-contract.cjs');
const { activatePickers, settle } = require('./workflow-layout-audit.cjs');

const base = process.env.BUTTON_AUDIT_URL || 'http://127.0.0.1:1422';
const out = path.resolve(process.env.BUTTON_AUDIT_OUTPUT || 'ui-audit-20261025/buttons/after');
const routes = ['fa_list', 'fa_dep_calc', 'fa_policy_compare', 'kanzhang', 'ts_manager',
  'confirmation_progress', 'file_list_directory', 'je_sign_mark', 'pdf_to_excel'];
fs.mkdirSync(out, { recursive: true });
const results = [];
const failures = [];

async function finish(page) {
  await page.waitForTimeout(1000);
  const confirm = page.locator('.confirm-dialog:visible button');
  if (await confirm.count()) {
    await confirm.last().evaluate(el => el.click());
    await page.waitForTimeout(1000);
  }
  const minimize = page.locator('.job-dialog:visible').getByRole('button', { name: '最小化', exact: true });
  if (await minimize.count()) await minimize.evaluate(el => el.click());
  await settle(page);
}

async function capture(page, tag) {
  await settle(page);
  const issues = await page.evaluate(auditButtonSizes);
  const groups = await page.locator('[data-button-size]').evaluateAll(elements => elements
    .filter(el => el.getBoundingClientRect().width > 0 && !el.closest('[hidden], [inert]'))
    .map(el => ({
      expected: el.dataset.buttonSize,
      className: el.className,
      buttons: [...el.querySelectorAll(':scope > [data-slot="button"]')].map(button => {
        const rect = button.getBoundingClientRect(), style = getComputedStyle(button);
        return { text: button.textContent.trim(), height: rect.height, padding: style.padding,
          fontSize: style.fontSize, borderWidth: style.borderWidth, size: button.dataset.size,
          disabled: button.disabled };
      }),
    })));
  results.push({ tag, viewport: page.viewportSize(), groups, issues });
  await page.screenshot({ path: path.join(out, `${tag}.png`), fullPage: true });
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ results, failures }, null, 2));
  if (issues.length) failures.push({ tag, issues });
  console.log(`${tag}: ${groups.length} 组，${issues.length} 处高度错误`);
}

async function click(page, name) {
  const button = page.locator('.main').getByRole('button', { name, exact: true }).first();
  await button.waitFor();
  if (!(await button.isEnabled())) throw new Error(`按钮不可用：${name}`);
  await button.evaluate(el => el.click());
  await finish(page);
}

async function drive(page, tool, prefix) {
  if (tool === 'fa_list') await page.getByRole('tab', { name: '两期固定资产清单' }).click();
  await capture(page, `${prefix}-initial`);
  await activatePickers(page);
  await finish(page);
  await capture(page, `${prefix}-loaded`);
  if (tool === 'fa_list') {
    await click(page, '开始匹配');
    await capture(page, `${prefix}-matched`);
    await click(page, '有，进入补充清单');
    await capture(page, `${prefix}-supplement`);
    await click(page, '无补充清单，跳过');
    await capture(page, `${prefix}-export`);
  } else if (tool === 'fa_dep_calc') {
    await click(page, '返回导入');
    await capture(page, `${prefix}-return-to-import`);
    await click(page, '下一步：核对映射');
  } else if (tool === 'fa_policy_compare') {
    await click(page, '下一步');
    await capture(page, `${prefix}-export`);
    await click(page, '生成折旧政策对比');
    await capture(page, `${prefix}-completed`);
  } else if (tool === 'kanzhang') {
    await click(page, '读取并自动映射');
    await capture(page, `${prefix}-mapping`);
    await click(page, '下一步：科目筛选');
    await capture(page, `${prefix}-accounts`);
    await click(page, '下一步：透视与导出');
    await capture(page, `${prefix}-export`);
  } else if (tool === 'ts_manager') {
    await click(page, '下一步：条件筛选');
    await capture(page, `${prefix}-filter`);
    await click(page, '下一步：导出');
    await capture(page, `${prefix}-export`);
  } else if (tool === 'confirmation_progress') {
    await click(page, '检查数据');
    await click(page, '下一步：报告范围');
    await capture(page, `${prefix}-scope`);
    await click(page, '下一步：生成报告');
    await capture(page, `${prefix}-export`);
    await click(page, '生成进度报告');
    await capture(page, `${prefix}-completed`);
  } else if (tool === 'file_list_directory') {
    await click(page, '下一步：输出文件');
    await capture(page, `${prefix}-export`);
  }
}

// 固定演示任务在运行中，覆盖共用加载区的停止按钮与 PDF 状态切换。
async function running(page, tool, prefix) {
  await page.evaluate(() => window.__demoTaskReplay.setAutoPlayback(false));
  if (tool === 'pdf_to_excel') await click(page, '开始转换');
  else await click(page, '读取并自动映射');
  const jobs = await page.evaluate(() => window.__demoTaskReplay.jobs());
  const job = jobs.at(-1);
  if (!job) throw new Error('未创建演示任务');
  for (const phase of ['running', 'paused']) {
    await page.evaluate(({ id, phase }) => window.__demoTaskReplay.inject(id, phase), { id: job.jobId, phase });
    await finish(page);
    await capture(page, `${prefix}-${phase}`);
  }
  await page.evaluate(id => window.__demoTaskReplay.inject(id, 'cancelled'), job.jobId);
  await finish(page);
  await capture(page, `${prefix}-cancelled`);
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-proxy-server'] });
  try {
    for (const width of [1600, 1000]) {
      for (const tool of routes) {
        const context = await browser.newContext({ viewport: { width, height: width === 1600 ? 900 : 680 }, reducedMotion: 'reduce' });
        const page = await context.newPage();
        page.setDefaultTimeout(8000);
        await page.addInitScript(() => {
          localStorage.setItem('audit-toolbox.demo-data', '1');
          localStorage.setItem('audit-toolbox.newbie-tour.v2', JSON.stringify({ newbieMode: false, workspaceDone: true }));
        });
        const prefix = `${width}-${tool}`;
        try {
          await page.goto(`${base}/#/tools/${tool}`, { waitUntil: 'domcontentloaded' });
          await page.locator('.page-header:visible').first().waitFor();
          await drive(page, tool, prefix);
          if (['je_sign_mark', 'pdf_to_excel'].includes(tool)) await running(page, tool, prefix);
        } catch (error) {
          failures.push({ tag: prefix, error: String(error) });
          console.error(`${prefix}: ${String(error).slice(0, 350)}`);
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ results, failures }, null, 2));
  }
  console.log(JSON.stringify({ output: out, states: results.length, failures: failures.length }));
  if (failures.length) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
