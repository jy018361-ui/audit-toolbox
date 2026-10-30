// Uses explicit synthetic demo replay, never native recording or cloud calls.
const {chromium}=require('playwright-core');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
(async()=>{
  const output=path.resolve('artifacts/meeting-regenerate-20261029');
  fs.mkdirSync(output,{recursive:true});
  const browser=await chromium.launch({channel:'chrome',headless:true,args:['--no-proxy-server']});
  const reports=[];
  try{
    for(const width of [1440,900]){
      const page=await browser.newPage({viewport:{width,height:1000},reducedMotion:'reduce'});
      const errors=[];
      const external=[];
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
      await page.getByRole('article',{name:'会议纪要正文'}).waitFor();
      const generate=page.getByRole('button',{name:'生成纪要',exact:true});
      const detail=page.getByRole('combobox',{name:'纪要详细度'});
      assert(await generate.isEnabled());
      assert((await page.locator('#meeting-generation-source').textContent()).includes('复用已有转写稿'));
      await detail.selectOption('detailed');
      await generate.click();
      await page.getByRole('article',{name:'会议纪要正文'}).filter({hasText:'以上为详细档合成示例'}).waitFor();
      assert(await generate.isEnabled());
      await detail.selectOption('brief');
      await generate.click();
      const article=page.getByRole('article',{name:'会议纪要正文'});
      await article.filter({hasText:'先整理缺口，再安排复核。'}).waitFor();
      assert(!(await article.textContent()).includes('补充讨论'));
      assert(await generate.isEnabled());
      await generate.scrollIntoViewIfNeeded();
      await page.screenshot({path:path.join(output,`regenerate-${width}.png`),fullPage:true});
      assert.deepEqual(errors,[]);
      assert.deepEqual(external,[]);
      reports.push({width,enabledWithoutUpload:true,detailedAndBriefReplay:'passed',sourceHint:'passed',pageErrors:errors,externalRequests:external});
      await page.close();
    }
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(reports,null,2));
    console.log('会议重新生成浏览器验收通过：无上传、切换详细度、任务完成后继续生成、来源提示；仅合成数据。');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
