// Browser QA uses only an isolated mock IPC store, never the user's database.
const { chromium } = require('playwright-core');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

(async () => {
  const output = path.resolve('artifacts/meeting-vocabulary-20261028');
  fs.mkdirSync(output, { recursive: true });
  const defaults = JSON.parse(fs.readFileSync('assets/meeting/vocabulary-defaults.json', 'utf8')).map(entry => ({ ...entry, id: randomUUID() }));
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-proxy-server'] });
  const reports = [];
  try {
    for (const width of [1440, 1000, 620]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(({ defaults }) => {
        localStorage.setItem('audit-toolbox.newbie-tour.v2', JSON.stringify({ newbieMode: false, workspaceDone: true }));
        let rows = structuredClone(defaults);
        window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
        window.__TAURI_INTERNALS__ = {
          metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
          transformCallback: () => 1, unregisterCallback: () => {},
          invoke: async (cmd, args) => {
            if (cmd === 'app_bootstrap') return { appVersion: '词库界面验收', platform: 'windows', arch: 'x64', webview2: true, engine: { available: true, version: null, mode: 'native' }, dataDir: 'mock', migrationRequired: false };
            if (cmd === 'settings_get') return {};
            if (cmd === 'history_get' || cmd === 'meeting_history_list') return [];
            if (cmd === 'meeting_status') return { watchEnabled: true, resident: false, inCall: false, logFound: false, recording: false };
            if (cmd === 'meeting_vocabulary_list') return structuredClone(rows);
            if (cmd === 'meeting_vocabulary_save') {
              const entry = structuredClone(args.entry);
              if (!entry.id) { entry.id = crypto.randomUUID(); rows.push(entry); }
              else rows = rows.map(row => row.id === entry.id ? entry : row);
              return structuredClone(rows);
            }
            if (cmd === 'meeting_vocabulary_delete') { rows = rows.filter(row => row.id !== args.id); return structuredClone(rows); }
            if (cmd === 'plugin:app|version') return 'test';
            if (cmd === 'plugin:updater|check') return null;
            if (cmd === 'plugin:window|is_maximized') return false;
            if (cmd === 'plugin:event|listen') return 1;
            return null;
          },
        };
      }, { defaults });
      await page.goto(`${process.env.MEETING_VOCABULARY_UI_URL || 'http://localhost:5173'}/#/tools/meeting_minutes/vocabulary`, { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: '编辑 CSDC', exact: true }).waitFor();
      if (width > 1000) await page.getByRole('button', { name: '会议纪要子菜单' }).scrollIntoViewIfNeeded();
      assert.equal(await page.locator('.meeting-vocabulary-word').count(), defaults.length);
      assert.equal(await page.getByRole('table').count(), 0);
      await page.screenshot({ path: path.join(output, `list-${width}.png`), fullPage: true });
      await page.getByRole('searchbox').fill('TRDA');
      assert.equal(await page.locator('.meeting-vocabulary-word').count(), 1);
      await page.getByRole('searchbox').fill('');
      await page.getByRole('button', { name: '新增词条', exact: true }).click();
      await page.getByLabel('标准名称', { exact: true }).fill('界面验收公司');
      await page.getByLabel('简称 / 别名', { exact: true }).fill('验收公司');
      await page.getByLabel('含义 / 使用语境', { exact: true }).fill('仅用于界面验收的合成词条');
      await page.screenshot({ path: path.join(output, `form-${width}.png`), fullPage: true });
      await page.getByRole('button', { name: '保存词条', exact: true }).click();
      await page.getByText('词条已保存，将用于后续新任务。', { exact: true }).waitFor();
      await page.getByRole('searchbox').fill('界面验收公司');
      await page.getByRole('button', { name: '编辑 界面验收公司', exact: true }).click();
      await page.getByLabel('标准名称', { exact: true }).fill('修改后的验收公司');
      await page.getByRole('button', { name: '保存词条', exact: true }).click();
      await page.getByRole('form', { name: '编辑词条' }).waitFor({ state: 'detached' });
      await page.getByRole('searchbox').fill('修改后的验收公司');
      await page.getByRole('button', { name: '编辑 修改后的验收公司', exact: true }).click();
      await page.getByRole('checkbox', { name: '启用该词条', exact: true }).uncheck();
      await page.getByRole('button', { name: '保存词条', exact: true }).click();
      await page.getByRole('form', { name: '编辑词条' }).waitFor({ state: 'detached' });
      await page.getByRole('button', { name: '编辑 修改后的验收公司', exact: true }).click();
      await page.getByRole('button', { name: '删除 修改后的验收公司', exact: true }).click();
      await page.getByRole('button', { name: '删除', exact: true }).click();
      await page.getByText('词条已删除。', { exact: true }).waitFor();
      const geometry = await page.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth }));
      assert(geometry.scroll <= geometry.viewport + 1, `页面溢出：${JSON.stringify(geometry)}`);
      if (width === 1000) {
        await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'classic-dark'));
        await page.getByRole('searchbox').fill('');
        await page.screenshot({ path: path.join(output, 'dark-1000.png'), fullPage: true });
      }
      assert.deepEqual(errors, []);
      reports.push({ width, defaults: defaults.length, crud: 'passed', errors, geometry });
      await page.close();
    }
  } finally { await browser.close(); }
  fs.writeFileSync(path.join(output, 'ui-report.json'), JSON.stringify(reports, null, 2));
  console.log(JSON.stringify(reports));
})().catch(error => { console.error(error); process.exitCode = 1; });
