const { chromium } = require('playwright-core');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Run against `npx vite preview --host 127.0.0.1 --port 1422`.
// deviceScaleFactor is browser DPI emulation, not a Windows display-setting test.
(async () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-ui-'));
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-proxy-server'] });
  const catalog = JSON.parse(fs.readFileSync('public/tool-catalog.json', 'utf8'));
  const routes = ['/', '/history', '/settings', ...catalog.map(x => x.route)];
  const results = [];
  try {
    for (const [width, height] of [[1440,900],[1180,760],[1000,680]]) {
      for (const scale of [1,1.25,1.5]) {
        const context = await browser.newContext({ viewport: {width,height}, deviceScaleFactor: scale, reducedMotion: 'reduce' });
        const page = await context.newPage();
        for (const theme of ['green-dark','blue-white','classic-dark','teal-dark']) {
          for (const route of routes) {
            await page.goto(`http://127.0.0.1:1422/#${route}`, { waitUntil: 'domcontentloaded' });
            await page.locator('.main').waitFor();
            await page.evaluate(async theme => {
              document.documentElement.dataset.theme = theme;
              const style = getComputedStyle(document.documentElement);
              const parse = color => { const c=document.createElement('canvas').getContext('2d');c.fillStyle=color;c.fillRect(0,0,1,1);return [...c.getImageData(0,0,1,1).data].slice(0,3); };
              const lum = rgb => rgb.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i],0);
              for(const key of ['brand','brand-link','brand-deep','brand-soft','accent']) {const l=lum(parse(style.getPropertyValue('--'+key)));document.documentElement.style.setProperty('--on-'+key,l>.179?'#11181b':'#ffffff');}
              await new Promise(requestAnimationFrame);
            },theme);
            await page.locator('.page-header:visible').first().waitFor();
            const result = await page.evaluate(() => {
              const main=document.querySelector('.main');
              const visible=e=>e.getClientRects().length && getComputedStyle(e).visibility!=='hidden' && !e.closest('[inert]');
              const overflowing=[...document.querySelectorAll('.main, .tool-page, .workspace')].filter(visible).filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>({class:e.className,scroll:e.scrollWidth,width:e.clientWidth}));
              const unlabeled=[...main.querySelectorAll('input:not([type=hidden]),select,textarea')].filter(visible).filter(e=>!e.labels?.length&&!e.getAttribute('aria-label')&&!e.getAttribute('aria-labelledby')).map(e=>({tag:e.tagName,placeholder:e.getAttribute('placeholder')}));
              return {overflowing,unlabeled,bodyOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth+1};
            });
            results.push({width,height,scale,theme,route,...result});
            if(route==='/' && scale===1) await page.screenshot({path:path.join(output,`${theme}-${width}.png`)});
            if(scale===1 && width===1000 && theme==='teal-dark' && ['/tools/fa_list','/tools/fuzzy_match','/tools/Excel_Merger','/tools/fx_audit','/settings'].includes(route)) await page.screenshot({path:path.join(output,route.replaceAll('/','_')+'.png'),fullPage:true});
          }
        }
        if(width===1000) {
          await page.goto('http://127.0.0.1:1422/');
          await page.getByRole('button',{name:'打开工具导航'}).click();
          for(let i=0;i<45;i++){await page.keyboard.press('Tab');if(!await page.evaluate(()=>document.querySelector('#app-sidebar').contains(document.activeElement)))throw Error('Drawer focus escaped');}
          await page.keyboard.press('Escape');
          if(!await page.getByRole('button',{name:'打开工具导航'}).evaluate(e=>e===document.activeElement))throw Error('Drawer focus not restored');
        }
        await context.close();
        console.log('Completed',width,height,scale);
      }
    }
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(results,null,2));
    console.log(JSON.stringify({output,cases:results.length,overflow:results.filter(x=>x.bodyOverflow||x.overflowing.length).slice(0,30),unlabeled:results.filter(x=>x.unlabeled.length).slice(0,15)},null,2));
    if(results.some(x=>x.bodyOverflow||x.overflowing.length||x.unlabeled.length))process.exitCode=1;
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
