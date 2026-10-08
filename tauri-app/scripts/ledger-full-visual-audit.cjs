const fs = require('fs');
const path = require('path');
const {chromium} = require('playwright-core');
const {activatePickers,auditGeometry,currentButtons} = require('./workflow-layout-audit.cjs');
const output=path.resolve(process.env.LEDGER_AUDIT_OUTPUT||'artifacts/ui-fix-20260926-ledger-interactions');
fs.mkdirSync(output,{recursive:true});
const report=[];
async function shot(page,w,tool,state){
  await page.waitForTimeout(400);
  report.push({width:w,tool,state,issues:await page.evaluate(auditGeometry)});
  await page.screenshot({path:path.join(output,`${w}-${tool}-${state}.png`)});
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
}
(async()=>{
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--no-proxy-server']});
try{for(const width of (process.env.LEDGER_AUDIT_WIDTHS||'1000,1180,1600').split(',').map(Number)){for(const tool of ['kanzhang','je_sign_mark']){
const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce'});
const page=await context.newPage();
await page.addInitScript(()=>{localStorage.setItem('audit-toolbox.demo-data','1');localStorage.setItem('audit-toolbox.newbie-tour.v2',JSON.stringify({newbieMode:false,workspaceDone:true}));});
await page.goto(`http://127.0.0.1:1422/?demo=1#/tools/${tool}`);
await page.waitForTimeout(1000);await activatePickers(page);await page.waitForTimeout(1400);
console.log(tool,width,await currentButtons(page));
const read=page.getByRole('button',{name:/读取并|读取文件|加载文件/});
if(await read.count()){await read.first().click();await page.waitForTimeout(1800);}
if(tool==='je_sign_mark'){
 await page.getByRole('button',{name:'选择目标科目',exact:true}).click();await page.waitForTimeout(500);
 await shot(page,width,tool,'target-picker');
 const dialog=page.getByRole('dialog');await dialog.getByRole('checkbox').nth(1).check();await dialog.getByRole('checkbox').nth(2).check();
 await dialog.getByRole('button',{name:'确认选择',exact:true}).click();
 await page.getByRole('button',{name:'新增批次',exact:true}).click();await shot(page,width,tool,'new-batch');
 await page.locator('.jm-tabs button,.kz-tabs button').first().click();
 await page.getByRole('button',{name:/筛选 凭证编号/}).click();await shot(page,width,tool,'column-filter');
 await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();
 await page.getByRole('button',{name:'标记并导出',exact:true}).click();await page.waitForTimeout(2500);
 await page.locator('.kz-result').last().scrollIntoViewIfNeeded();await shot(page,width,tool,'export-completed');
}else{
 await page.getByRole('button',{name:'下一步：科目筛选',exact:true}).click();await page.waitForTimeout(1300);
 await page.getByRole('button',{name:'套用审计关注科目预设（8类）',exact:true}).click();
 await page.locator('.kz-tabs').scrollIntoViewIfNeeded();await shot(page,width,tool,'account-batches');
 await page.getByRole('button',{name:'筛选预览',exact:true}).click();await page.waitForTimeout(2400);
 await page.locator('.kz-result').last().scrollIntoViewIfNeeded();await shot(page,width,tool,'filter-completed');
 await page.getByRole('button',{name:'下一步：透视与导出',exact:true}).click();await shot(page,width,tool,'pivot-settings');
 await page.getByRole('button',{name:'导出结果',exact:true}).click();await page.waitForTimeout(2400);
 await page.locator('.kz-result').last().scrollIntoViewIfNeeded();await shot(page,width,tool,'export-completed');
 await page.getByRole('button',{name:'返回筛选',exact:true}).click();await shot(page,width,tool,'return-edit');
}
await context.close();}}
}finally{await browser.close();}console.log(JSON.stringify(report,null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
