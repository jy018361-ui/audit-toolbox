// Isolated browser preview. Synthetic long sections exercise real tool routes
// without opening user files, starting native jobs or calling cloud services.
const { chromium } = require('playwright-core');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const catalog = require('../public/tool-catalog.json');

(async () => {
  const output = path.resolve('artifacts/tool-view-restoration-20261029');
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-proxy-server'] });
  const reports = [];
  try {
    for (const width of [1440, 1000]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => {
        localStorage.setItem('audit-toolbox.newbie-tour.v2', JSON.stringify({ newbieMode: false, workspaceDone: true }));
      });
      await page.goto(`${process.env.TOOL_VIEW_UI_URL || 'http://localhost:1420'}/#/`, { waitUntil: 'networkidle' });
      const goto = async route => {
        await page.evaluate(route => { window.location.hash = `#${route}`; }, route);
        await page.waitForFunction(route => location.hash === `#${route}`, route);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      };
      const checkOffset = async (target) => {
        await page.waitForFunction(target => Math.abs(scrollY - target) <= 1, target, { timeout: 5000 });
      };
      const installLongView = async id => {
        const wrapper = page.locator(`[data-tool-page="${id}"]`);
        await wrapper.waitFor({ state: 'visible' });
        await wrapper.locator(':scope > *').first().waitFor();
        await page.waitForTimeout(80);
        await wrapper.evaluate((element, id) => {
          const fixture = document.createElement('section');
          fixture.dataset.scrollFixture = id;
          fixture.style.cssText = 'height:2600px;padding:20px;background:var(--surface)';
          fixture.innerHTML = `<p>滚动恢复验收合成区域</p><input aria-label="验收草稿" value="draft-${id}"/><div data-inner-scroll style="width:200px;height:100px;overflow:auto"><div style="width:900px;height:900px">内部滚动</div></div>`;
          element.appendChild(fixture);
        }, id);
        return wrapper;
      };
      // Save a distinct viewport and nested table offset for every catalog tool,
      // including read-only pages that would previously have been LRU-evicted.
      for (const [index, tool] of catalog.entries()) {
        await goto(tool.route);
        await checkOffset(0);
        const wrapper = await installLongView(tool.id);
        await wrapper.locator('[data-inner-scroll]').evaluate(element => { element.scrollTop = 340; element.scrollLeft = 160; });
        await page.evaluate(top => window.scrollTo(0, top), 400 + index * 19);
        await checkOffset(400 + index * 19);
        await page.waitForTimeout(35);
      }
      await goto('/');
      await checkOffset(0);
      for (const [index, tool] of catalog.entries()) {
        await goto(tool.route);
        await checkOffset(400 + index * 19);
        const wrapper = page.locator(`[data-tool-page="${tool.id}"]`);
        assert.equal(await wrapper.locator('[aria-label="验收草稿"]').inputValue(), `draft-${tool.id}`);
        const inner = await wrapper.locator('[data-inner-scroll]').evaluate(element => ({ top: element.scrollTop, left: element.scrollLeft }));
        assert.deepEqual(inner, { top: 340, left: 160 });
      }
      // Actual sidebar clicks, including narrow-screen drawer closing/focus.
      await goto('/tools/meeting_minutes');
      const clickTool = async id => {
        if (!await page.locator('aside.sidebar').isVisible()) await page.getByRole('button', { name: '打开工具导航' }).click();
        await page.locator(`aside.sidebar a[href="#/tools/${id}"]`).click();
        await page.waitForTimeout(120);
      };
      await clickTool('ocr');
      await checkOffset(400 + catalog.findIndex(tool => tool.id === 'ocr') * 19);
      await clickTool('meeting_minutes');
      await checkOffset(400 + catalog.findIndex(tool => tool.id === 'meeting_minutes') * 19);
      // Manual scroll back to the top replaces the old saved offset.
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(40);
      await goto('/settings');
      await checkOffset(0);
      await page.evaluate(() => window.scrollTo(0, 600));
      await page.waitForTimeout(40);
      await goto('/tools/meeting_minutes');
      await checkOffset(0);
      await page.screenshot({ path: path.join(output, `restored-${width}.png`) });
      assert.deepEqual(errors, []);
      reports.push({ width, tools: catalog.map(tool => tool.id), documentAndNestedOffsets: 'passed', sidebarAndDrawer: 'passed', readOnlyRetention: 'passed', pageErrors: errors });
      await page.close();
    }
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(reports, null, 2));
    console.log(`工具视图恢复浏览器验收通过：全部目录工具，1440/1000宽度，页面及内部横纵滚动、侧栏/抽屉往返；仅使用合成内容。报告：${output}`);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
