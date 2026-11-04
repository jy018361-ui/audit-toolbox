// Local synthetic demo only; no native recording, file changes or cloud requests.
const {chromium}=require('playwright-core');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
(async()=>{
  const output=path.resolve('artifacts/meeting-info-20261102');
  fs.mkdirSync(output,{recursive:true});
  const browser=await chromium.launch({channel:'chrome',headless:true,args:['--no-proxy-server']});
  const reports=[];
  try{
    for(const width of [1440,900,390]){
      const page=await browser.newPage({viewport:{width,height:1000},reducedMotion:'reduce'});
      const errors=[],external=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.route('**/*',route=>{
        const url=new URL(route.request().url());
        if(url.protocol.startsWith('http')&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname)){
          external.push(url.hostname);return route.abort();
        }
        return route.continue();
      });
      await page.addInitScript(()=>localStorage.setItem('audit-toolbox.newbie-tour.v2',JSON.stringify({newbieMode:false,workspaceDone:true})));
      await page.goto(`${process.env.MEETING_UI_URL||'http://localhost:1420'}/?demo=1#/tools/meeting_minutes`,{waitUntil:'domcontentloaded'});
      const region=page.getByRole('region',{name:'说话人姓名对应'});
      const article=page.getByRole('article',{name:'会议纪要正文'});
      const speaker=article.locator('[data-meeting-speaker="1"]').first();
      await page.waitForFunction(()=>document.querySelector('article [data-meeting-speaker="1"]')?.textContent.includes('%'));
      const percentage=(await speaker.textContent()).match(/（[^）]+%）/)[0];
      assert.equal(percentage,'（80%）');
      assert(!(await region.textContent()).includes('%'));
      assert((await article.textContent()).includes('2026-11-02（周一）'));
      assert((await page.getByLabel('会议历史列表').textContent()).includes('2026-11-02（周一）'));
      const assertOnlyParticipantPercentages=async()=>{
        const text=await article.textContent();
        const participants=await article.locator('p').filter({hasText:/^参会人员[:：]/}).textContent();
        assert.equal((text.match(/%/g)||[]).length,(participants.match(/%/g)||[]).length);
        if(await article.locator('table').count()) assert(!(await article.locator('table').textContent()).includes('%'));
      };
      await assertOnlyParticipantPercentages();
      const input=region.getByRole('textbox',{name:'说话人1姓名'});
      await input.fill('张三');await input.press('Enter');
      assert.equal(await speaker.textContent(),`张三${percentage}`);
      await page.getByRole('button',{name:'按时间',exact:true}).click();
      assert.equal(await speaker.textContent(),`张三${percentage}`);
      await assertOnlyParticipantPercentages();
      await article.focus();await article.press('Control+End');
      await page.keyboard.press('Enter');await page.keyboard.insertText('用户补充的纪要正文。');
      assert.equal(await speaker.textContent(),`张三${percentage}`);
      assert(!(await article.textContent()).includes(`${percentage}${percentage}`));
      await article.scrollIntoViewIfNeeded();
      await page.screenshot({path:path.join(output,`speaker-shares-${width}.png`),fullPage:true});
      const overflow=await region.evaluate(el=>el.scrollWidth>el.clientWidth+1);
      assert(!overflow);
      assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
      reports.push({width,percentage,onlyParticipantsHavePercentage:true,recordingAndHistoryHaveWeekdays:true,inputsHaveNoPercentage:true,namesAndEditsKeepShares:true,regionOverflow:overflow,pageErrors:errors,externalRequests:external});
      await page.close();
    }
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(reports,null,2));
    console.log('说话人占比浏览器验收通过：宽窄屏、改名、切版本、正文编辑；仅本地合成数据。');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
