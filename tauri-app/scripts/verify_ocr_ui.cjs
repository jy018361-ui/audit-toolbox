const { chromium } = require('playwright-core');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const output = path.resolve('artifacts/ocr-20261027');
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-proxy-server'] });
  const results = [];
  try {
    for (const width of [1440, 1000]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      await page.addInitScript(() => localStorage.setItem('audit-toolbox.newbie-tour.v2', JSON.stringify({ newbieMode: false, workspaceDone: true })));
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${process.env.OCR_AUDIT_URL || 'http://127.0.0.1:1422'}/?demo=1#/tools/ocr`, { waitUntil: 'networkidle' });
      await page.locator('.ocr-document').first().waitFor();
      await page.locator('.ocr-document').first().click();
      await page.locator('.ocr-source img').waitFor();
      await page.waitForFunction(() => document.querySelector('.ocr-source img')?.naturalWidth > 0);
      await page.locator('.ocr-edit-table').first().waitFor();
      await page.screenshot({ path: path.join(output, `ocr-${width}-comparison.png`), fullPage: true });
      assert.equal(await page.getByLabel('本页完整正文', { exact: true }).count(), 0, 'Source text must be read-only');
      assert.equal(await page.getByRole('button', { name: '新增表格', exact: true }).count(), 0, 'No manual table creation');
      await page.getByRole('button', { name: '2 判断摘录', exact: true }).click();
      await page.locator('.ocr-comparison').waitFor({ state: 'detached' });
      await page.getByLabel('摘录场景', { exact: true }).selectOption('custom');
      const prompt = page.locator('.ocr-prompt-stage textarea').first();
      await prompt.waitFor();
      const saved = await prompt.inputValue();
      assert(saved.length > 30, 'Default/project prompt should be fully visible and editable');
      await prompt.fill(`${saved}\n只摘录合成样例中的金额。`);
      await page.getByRole('button', { name: '保存提示词', exact: true }).click();
      await page.getByText('提示词已保存到当前项目。', { exact: true }).waitFor();
      await page.getByLabel('摘录场景', { exact: true }).selectOption('invoice');
      await page.getByLabel('摘录场景', { exact: true }).selectOption('custom');
      assert((await prompt.inputValue()).includes('只摘录合成样例中的金额。'));
      await page.getByRole('button', { name: '开始摘录', exact: true }).click();
      await page.getByText('摘录已保存。可查看原文证据，或导出 Excel。', { exact: true }).waitFor();
      await page.locator('.ocr-extraction').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, `ocr-${width}-prompts.png`), fullPage: true });
      const geometry = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        unlabeled: [...document.querySelectorAll('.ocr-page input,.ocr-page select,.ocr-page textarea')]
          .filter(element => element.getClientRects().length && !element.labels?.length && !element.getAttribute('aria-label') && !element.getAttribute('aria-labelledby'))
          .map(element => element.outerHTML.slice(0, 120)),
        imageWidth: document.querySelector('.ocr-source img')?.naturalWidth,
      }));
      assert.equal(geometry.overflow, false, `Page overflow at ${width}px`);
      assert.deepEqual(geometry.unlabeled, []);
      assert.deepEqual(errors, []);
      results.push({ width, ...geometry, errors });
      await page.close();
    }
    fs.writeFileSync(path.join(output, 'ui-checks.json'), JSON.stringify(results, null, 2));
    console.log('OCR 页面验收通过：宽窄窗口、有效扫描页、表格校对、提示词编辑保存与实际摘录。');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
