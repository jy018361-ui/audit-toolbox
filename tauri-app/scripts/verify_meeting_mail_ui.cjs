const {chromium} = require('playwright-core');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

(async()=>{
  const output = path.resolve('artifacts/meeting-mail-20261029');
  const markdown = fs.readFileSync(path.join(output,'会议纪要合成样例.md'),'utf8');
  const browser = await chromium.launch({channel:'chrome',headless:true,args:['--no-proxy-server']});
  const reports=[];
  try {
    for (const width of [1440,900,390]) {
      const page = await browser.newPage({viewport:{width,height:1000},reducedMotion:'reduce'});
      const errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      page.on('response',response=>{
        if(response.status()>=400 && !response.url().endsWith('/favicon.ico')) errors.push(`${response.status()} ${response.url()}`);
      });
      await page.addInitScript(({markdown})=>{
        localStorage.setItem('audit-toolbox.newbie-tour.v2',JSON.stringify({newbieMode:false,workspaceDone:true}));
        window.__mailQa={copies:[],drafts:[]};
        Object.defineProperty(navigator,'clipboard',{configurable:true,value:{
          write:async items=>{
            const copy={};
            for (const type of items[0].types) copy[type]=await (await items[0].getType(type)).text();
            window.__mailQa.copies.push(copy);
          },
          writeText:async text=>window.__mailQa.copies.push({'text/plain':text}),
        }});
        window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
        window.__TAURI_INTERNALS__={
          metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},
          transformCallback:()=>1,unregisterCallback:()=>{},
          invoke:async(cmd,args)=>{
            if(cmd==='app_bootstrap')return{appVersion:'邮件界面验收',platform:'windows',arch:'x64',webview2:true,engine:{available:true,version:null,mode:'native'},dataDir:'mock',migrationRequired:false};
            if(cmd==='settings_get')return{};
            if(cmd==='history_get')return[];
            if(cmd==='meeting_status')return{watchEnabled:true,resident:false,inCall:false,logFound:true,recording:false};
            if(cmd==='meeting_history_list')return[{id:'sample',jobId:'sample',title:'季度审计项目协调会',startedAt:'2026-10-29T10:00:00+08:00',timeLabel:'生成时间',status:'completed',message:''}];
            if(cmd==='meeting_history_get')return{minutesVersions:[
              {kind:'content',label:'按内容',minutesPath:'C:/mock/content.md',minutesMarkdown:markdown.replace('张三汇报','说话人1汇报')},
              {kind:'timeline',label:'按时间',minutesPath:'C:/mock/timeline.md',minutesMarkdown:'# 季度审计项目协调会（按时间）\n\n[00:00] 张三介绍审计进度。'},
            ]};
            if(cmd==='meeting_create_mail_draft'){
              window.__mailQa.drafts.push(args);
              return{saved:true,displayed:true,message:'已生成 Outlook 邮件草稿，请填写收件人并检查后发送。'};
            }
            if(cmd==='plugin:app|version')return'test';
            if(cmd==='plugin:updater|check')return null;
            if(cmd==='plugin:window|is_maximized')return false;
            if(cmd==='plugin:event|listen')return 1;
            return null;
          },
        };
      },{markdown});
      await page.goto(`${process.env.MEETING_MAIL_UI_URL||'http://localhost:1420'}/#/tools/meeting_minutes`,{waitUntil:'domcontentloaded'});
      try {
        await page.getByRole('article',{name:'会议纪要正文'}).waitFor();
      } catch(error) {
        fs.writeFileSync(path.join(output,'browser-failure.json'),JSON.stringify({errors,body:await page.locator('body').innerText()},null,2));
        throw error;
      }
      const draft=page.getByRole('button',{name:'生成邮件草稿',exact:true});
      const speaker=page.getByRole('textbox',{name:'说话人1姓名',exact:true});
      await speaker.fill('张三');
      await speaker.press('Enter');
      assert.equal(await draft.evaluate(button=>button.previousElementSibling.textContent.trim()),'打开输出文件夹');
      await page.getByRole('button',{name:'复制正文',exact:true}).click();
      await page.getByText('已复制（含格式）',{exact:true}).waitFor();
      const copied=await page.evaluate(()=>window.__mailQa.copies[0]);
      assert(copied['text/html'].includes('<table'));
      assert(copied['text/html'].includes('Microsoft YaHei'));
      assert(copied['text/html'].includes('张三汇报'));
      assert(!copied['text/html'].includes('说话人1'));
      assert(copied['text/plain'].includes('责任人\t截止时间'));
      await draft.click();
      await page.getByText('已生成 Outlook 邮件草稿，请填写收件人并检查后发送。',{exact:true}).waitFor();
      let mail=await page.evaluate(()=>window.__mailQa.drafts[0]);
      assert.equal(mail.subject,'季度审计项目协调会_会议纪要');
      assert.equal(mail.htmlBody,copied['text/html']);
      await draft.scrollIntoViewIfNeeded();
      await page.screenshot({path:path.join(output,`actions-${width}.png`)});
      await page.getByRole('button',{name:'按时间',exact:true}).click();
      await draft.click();
      await page.waitForFunction(()=>window.__mailQa.drafts.length===2);
      mail=await page.evaluate(()=>window.__mailQa.drafts[1]);
      assert(mail.htmlBody.includes('张三介绍审计进度。'));
      assert(!mail.htmlBody.includes('[00:00]'));
      assert(!mail.htmlBody.includes('（按时间）'));
      assert(!mail.htmlBody.includes('（按内容）'));
      assert(!mail.htmlBody.includes('后续事项'));
      const noOverflow=await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1);
      assert(noOverflow);
      assert.deepEqual(errors,[]);
      reports.push({width,richCopy:'passed',draftBodyMatchesCopy:'passed',versionSelection:'passed',buttonPosition:'passed',noOverflow,pageErrors:errors});
      await page.close();
    }
    const sample=await browser.newPage({viewport:{width:960,height:1100}});
    await sample.setContent(fs.readFileSync(path.join(output,'会议纪要邮件样例.html'),'utf8'));
    await sample.screenshot({path:path.join(output,'邮件样例预览.png'),fullPage:true});
    assert((await sample.locator('td').first().evaluate(element=>getComputedStyle(element).fontFamily)).includes('Microsoft YaHei'));
    await sample.close();
    fs.writeFileSync(path.join(output,'ui-report.json'),JSON.stringify(reports,null,2));
    console.log(`会议富文本复制与邮件草稿界面验收通过：1440/900/390；报告：${output}`);
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
