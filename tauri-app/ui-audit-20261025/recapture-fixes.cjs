const { chromium } = require("playwright-core");
const path = require("node:path");
const out = path.resolve(__dirname, "shots");
async function settle(p){ await p.waitForTimeout(400); await p.evaluate(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));}).catch(()=>{}); }
async function shot(p,name){ await settle(p); await p.screenshot({path:path.join(out,name),fullPage:true}); console.log("captured",name); }
async function minimize(p){ const d=p.locator(".job-dialog:visible"); if(await d.count()){ await p.waitForTimeout(900); const m=d.getByRole("button",{name:"最小化"}); if(await m.count()) await m.click(); await p.waitForTimeout(200);} }
(async()=>{
  const browser = await chromium.launch({ channel:"chrome", headless:true, args:["--no-proxy-server"] });
  const ctx = await browser.newContext({ viewport:{width:1600,height:900}, reducedMotion:"reduce" });
  const page = await ctx.newPage();
  await page.addInitScript(()=>{ localStorage.setItem("audit-toolbox.newbie-tour.v2",JSON.stringify({newbieMode:false,workspaceDone:true})); localStorage.setItem("audit-toolbox.demo-data","1"); });

  // loan_tb step2（渐隐盖表头）
  await page.goto("http://127.0.0.1:1422/#/tools/loan_interest",{waitUntil:"domcontentloaded"});
  await page.locator(".page-header:visible").first().waitFor({timeout:15000});
  await page.waitForTimeout(400);
  await page.locator(".main button:visible").filter({hasText:"TB＋JE"}).first().click();
  await page.waitForTimeout(500);
  const drop = page.locator(".file-drop-zone:visible").first();
  if(await drop.count()){ await drop.click(); await page.waitForTimeout(1600); await minimize(page); }
  await page.locator(".main button:visible").filter({hasText:"下一步：确认科目与利率"}).first().click();
  await page.waitForTimeout(1600); await minimize(page);
  await shot(page,"pages/loan_tb-step2-rates.png");

  // tbje step2
  await page.goto("http://127.0.0.1:1422/#/tools/tbje_check",{waitUntil:"domcontentloaded"});
  await page.waitForTimeout(500);
  const tdrop = page.locator(".file-drop-zone:visible").first();
  if(await tdrop.count()){ await tdrop.click(); await page.waitForTimeout(1500); await minimize(page); }
  const tnext = page.locator(".main button:visible").filter({hasText:"下一步"}).first();
  if(await tnext.count()){ await tnext.click(); await page.waitForTimeout(1500); await minimize(page); }
  await shot(page,"pages/tbje_check-step2-state.png");

  // confirmation step1
  await page.goto("http://127.0.0.1:1422/#/tools/confirmation_progress",{waitUntil:"domcontentloaded"});
  await page.waitForTimeout(500);
  const cdrop = page.locator(".file-drop-zone:visible").first();
  if(await cdrop.count()){ await cdrop.click(); await page.waitForTimeout(1400); await minimize(page); }
  const check = page.locator(".main button:visible").filter({hasText:"检查数据"}).first();
  if(await check.count()){ await check.click(); await page.waitForTimeout(1400); await minimize(page); }
  await shot(page,"pages/confirmation_progress-step1-state.png");

  // kanzhang step6
  await page.goto("http://127.0.0.1:1422/#/tools/kanzhang",{waitUntil:"domcontentloaded"});
  await page.waitForTimeout(500);
  const kdrop = page.locator(".file-drop-zone:visible").first();
  if(await kdrop.count()){ await kdrop.click(); await page.waitForTimeout(1500); await minimize(page); }
  for(const label of ["读取并自动映射","下一步：科目筛选","下一步：透视与导出"]){
    const b = page.locator(".main button:visible").filter({hasText:label}).first();
    if(await b.count()){ await b.click(); await page.waitForTimeout(1000); await minimize(page); }
  }
  await shot(page,"pages/kanzhang-step6-state.png");

  // overlay-step（标题截断）
  await page.goto("http://127.0.0.1:1420/?overlay-fixture=step",{waitUntil:"commit"});
  await page.locator(".overlay-state-fixture").waitFor();
  await page.waitForTimeout(1500);
  await shot(page,"overlays/overlay-step.png");

  // task paused / partial / completed（不点展开，验证按钮与继续）
  for(const state of ["paused","partial","completed"]){
    await page.goto(`http://127.0.0.1:1420/?task-state-fixture=1&tool=loan_interest&state=${state}`,{waitUntil:"commit"});
    await page.locator(".task-state-fixture").waitFor();
    await page.waitForTimeout(500);
    await shot(page,`overlays/task-loan_interest-${state}.png`);
  }
  await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
