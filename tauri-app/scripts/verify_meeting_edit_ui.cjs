// UI QA with synthetic minutes and an isolated mock IPC file store.
const { chromium } = require('playwright-core');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const output = path.resolve('artifacts/meeting-inline-20261029');
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-proxy-server'] });
  const reports = [];
  try {
    for (const width of [1440, 900, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 950 }, reducedMotion: 'reduce' });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => {
        localStorage.setItem('audit-toolbox.newbie-tour.v2', JSON.stringify({newbieMode:false,workspaceDone:true}));
        const initial = {
          'C:/mock/content.md': {minutesMarkdown:'# 项目协调会（按内容）\n\n## 讨论\n说话人1负责复核，张三提供材料。说话人10补充意见。\n\n|责任人|事项|\n|---|---|\n|说话人2|整理底稿|'},
          'C:/mock/timeline.md': {minutesMarkdown:'# 项目协调会（按时间）\n\n[00:00] 说话人1发言。\n[00:10] 说话人2回应。'},
          'C:/mock/other.md': {minutesMarkdown:'# 另一场会议\n\n说话人1发言。'},
        };
        const documents = JSON.parse(localStorage.getItem('qa.minutes') || 'null') || initial;
        window.__meetingEditQa = { documents, failNext: false, saves: [] };
        window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
        window.__TAURI_INTERNALS__ = {
          metadata: {currentWindow:{label:'main'},currentWebview:{label:'main'}},
          transformCallback: () => 1, unregisterCallback: () => {},
          invoke: async (cmd, args) => {
            if (cmd === 'app_bootstrap') return {appVersion:'编辑验收',platform:'windows',arch:'x64',webview2:true,engine:{available:true,version:null,mode:'native'},dataDir:'mock',migrationRequired:false};
            if (cmd === 'settings_get') return {};
            if (cmd === 'history_get') return [];
            if (cmd === 'meeting_status') return {watchEnabled:true,resident:false,inCall:false,logFound:true,recording:false};
            if (cmd === 'meeting_history_list') return [
              {id:'first',jobId:'first',title:'项目协调会',startedAt:'2026-10-29T10:00:00+08:00',timeLabel:'生成时间',status:'completed',message:''},
              {id:'other',jobId:'other',title:'另一场会议',startedAt:'2026-10-28T10:00:00+08:00',timeLabel:'生成时间',status:'completed',message:''},
            ];
            if (cmd === 'meeting_history_get') return args.id === 'other'
              ? {minutesPath:'C:/mock/other.md'}
              : {transcriptPath:'C:/mock/raw.txt',speakerCount:3,minutesVersions:[
                {kind:'content',label:'按内容',minutesPath:'C:/mock/content.md'},
                {kind:'timeline',label:'按时间',minutesPath:'C:/mock/timeline.md'},
              ]};
            if (cmd === 'meeting_read_minutes') return structuredClone({...documents[args.path],minutesPath:args.path});
            if (cmd === 'meeting_read_transcript') return '[00:00] 说话人1：原始发言。';
            if (cmd === 'meeting_save_minutes') {
              const qa = window.__meetingEditQa;
              if (qa.failNext) { qa.failNext = false; throw {userMessage:'验收：文件暂时被占用'}; }
              if (documents[args.path].minutesMarkdown !== args.expectedMarkdown) throw {userMessage:'验收：文件已被修改'};
              const rendered = args.minutesMarkdown.replace(/说话人[ \t]*([1-9]\d*)/g, (label,id) => args.speakerNames[id] || label);
              documents[args.path] = {minutesPath:args.path,minutesMarkdown:rendered,sourceMarkdown:args.minutesMarkdown,speakerNames:args.speakerNames};
              qa.saves.push(args.path);
              localStorage.setItem('qa.minutes', JSON.stringify(documents));
              return structuredClone(documents[args.path]);
            }
            if (cmd === 'plugin:app|version') return 'test';
            if (cmd === 'plugin:updater|check') return null;
            if (cmd === 'plugin:window|is_maximized') return false;
            if (cmd === 'plugin:event|listen') return 1;
            return null;
          },
        };
      });
      await page.goto(`${process.env.MEETING_EDIT_UI_URL || 'http://localhost:1420'}/#/tools/meeting_minutes`, {waitUntil:'domcontentloaded'});
      const article = page.getByRole('article', {name:'会议纪要正文'});
      await article.waitFor();
      const name = page.getByRole('textbox', {name:'说话人1姓名',exact:true});
      await name.fill('张三');
      await name.press('Enter');
      await page.waitForFunction(() => document.querySelector('.meeting-minutes-content')?.textContent.includes('张三负责复核'));
      assert((await article.textContent()).includes('说话人10补充意见'));
      await page.getByRole('button', {name:'按时间',exact:true}).click();
      await page.waitForFunction(() => document.querySelector('.meeting-minutes-content')?.textContent.includes('张三发言'));
      await page.getByRole('button', {name:'按内容',exact:true}).click();
      assert.equal(await page.getByRole('button', {name:'编辑正文',exact:true}).count(), 0);
      assert.equal(await page.getByRole('button', {name:'保存姓名及全部修改',exact:true}).count(), 0);
      assert.equal(await article.getAttribute('contenteditable'), 'true');
      await page.waitForFunction(() => window.__meetingEditQa.saves.length >= 2);
      await page.evaluate(() => { window.__meetingEditQa.failNext = true; });
      await article.locator('p').first().click();
      await page.keyboard.press('End');
      await page.keyboard.insertText('人工修改：请在周五完成。');
      await page.getByRole('alert').filter({hasText:'文件暂时被占用'}).waitFor();
      assert((await article.textContent()).includes('人工修改：请在周五完成。'));
      assert.equal(await article.locator('table').count(), 1);
      await page.getByRole('button', {name:'重试自动保存',exact:true}).click();
      await page.getByText('已自动保存',{exact:true}).waitFor();
      // Modify an actual table cell in place and ensure its table survives.
      await article.locator('td').last().click();
      await page.keyboard.press('End');
      await page.keyboard.insertText('，已复核');
      await page.waitForFunction(() => window.__meetingEditQa.documents['C:/mock/content.md'].minutesMarkdown.includes('已复核'));
      await page.getByRole('button', {name:'按时间',exact:true}).click();
      assert(!(await article.textContent()).includes('[00:00]'));
      await page.getByRole('button', {name:'按内容',exact:true}).click();
      assert((await article.textContent()).includes('人工修改：请在周五完成。'));
      await page.screenshot({path:path.join(output,`inline-${width}.png`),fullPage:true});
      const saved = await page.evaluate(() => window.__meetingEditQa.documents);
      assert(saved['C:/mock/content.md'].minutesMarkdown.includes('张三负责复核，张三提供材料。'));
      assert(saved['C:/mock/content.md'].minutesMarkdown.includes('人工修改：请在周五完成。'));
      assert(saved['C:/mock/timeline.md'].minutesMarkdown.includes('张三发言'));
      assert(!saved['C:/mock/timeline.md'].minutesMarkdown.includes('[00:00]'));
      await page.reload({waitUntil:'domcontentloaded'});
      await article.waitFor();
      assert.equal(await name.inputValue(), '张三');
      await name.fill('王五');
      await name.press('Enter');
      await page.waitForFunction(() => document.querySelector('.meeting-minutes-content')?.textContent.includes('王五负责复核，张三提供材料。'));
      await page.waitForFunction(() => window.__meetingEditQa.documents['C:/mock/content.md'].minutesMarkdown.includes('王五负责复核'));
      await page.getByRole('button', {name:'原始转写',exact:true}).click();
      await page.getByRole('article', {name:'原始转写正文'}).waitFor();
      assert((await page.getByRole('article', {name:'原始转写正文'}).textContent()).includes('说话人1：原始发言'));
      await page.getByRole('button', {name:'另一场会议',exact:true}).click();
      await page.waitForFunction(() => document.querySelector('.meeting-minutes-content')?.textContent.includes('另一场会议'));
      assert.equal(await name.inputValue(), '');
      const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
      assert(noOverflow, `页面横向溢出 ${width}`);
      assert.deepEqual(errors, []);
      reports.push({width,editing:'passed',namesAndReopen:'passed',versionDrafts:'passed',failureRetainsDraft:'passed',meetingIsolation:'passed',noOverflow,pageErrors:errors});
      await page.close();
    }
    fs.writeFileSync(path.join(output,'ui-report.json'),JSON.stringify(reports,null,2));
    console.log(`会议编辑与姓名替换界面验收通过：1440/900/390宽度，编辑、跨版本草稿、失败重试、双版保存与重开、改名及会议隔离；报告：${output}`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
