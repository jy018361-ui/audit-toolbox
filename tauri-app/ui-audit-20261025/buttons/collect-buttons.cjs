/* Read-only button audit. Reuse the existing demo workflow/overlay driver. */
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const out = __dirname;
fs.mkdirSync(path.join(out, "shots"), { recursive: true });
const driverPath = path.resolve(__dirname, "../capture-acceptance.cjs");
let source = fs.readFileSync(driverPath, "utf8");
const stable = process.env.BUTTON_AUDIT_STABLE === "1";
const extra = process.env.BUTTON_AUDIT_SUPPLEMENT === "1";
const begin = source.indexOf("async function capture(page, folder, name) {");
const end = source.indexOf("\nasync function currentButtons", begin);
if (begin < 0 || end < 0) throw new Error("采集驱动结构已变化，请检查后重跑");
if (!stable) source = source.replace('const preview = "http://127.0.0.1:1422";', 'const preview = "http://127.0.0.1:1420";');
// The replacement above has the same length, preserving the function offsets.
const replacement = `
const records = [];
async function capture(page, folder, name) {
  await settle(page);
  const data = await page.evaluate(() => {
    const visible = el => {
      const r = el.getBoundingClientRect(), s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const selector = el => {
      if (!el) return '';
      if (el.id) return '#' + el.id;
      return el.tagName.toLowerCase() + [...el.classList].slice(0, 4).map(c => '.' + c).join('');
    };
    const all = [...document.querySelectorAll('main button, .main button, [role="dialog"] button, .overlay-state-fixture button, .task-state-fixture button')].filter(visible);
    const buttons = all.map((el, i) => {
      const s = getComputedStyle(el), r = el.getBoundingClientRect();
      return {
        i, text: (el.textContent || '').replace(/\\s+/g, ' ').trim(),
        aria: el.getAttribute('aria-label'), size: el.dataset.size || 'native', variant: el.dataset.variant || '',
        selector: selector(el), parent: selector(el.parentElement),
        ancestors: [el.parentElement, el.parentElement?.parentElement, el.parentElement?.parentElement?.parentElement].map(selector),
        width: +r.width.toFixed(2), height: +r.height.toFixed(2),
        font: s.fontSize, lineHeight: s.lineHeight, padding: s.padding,
        minHeight: s.minHeight, cssHeight: s.height, border: s.borderWidth,
        disabled: el.disabled, x: +r.x.toFixed(2), y: +r.y.toFixed(2),
      };
    });
    const groups = [];
    const parents = new Set(all.map(el => el.parentElement));
    for (const parent of parents) {
      const indices = all.map((el, i) => el.parentElement === parent ? i : -1).filter(i => i >= 0);
      if (indices.length < 2) continue;
      const peers = indices.map(i => buttons[i]);
      const delta = Math.max(...peers.map(b => b.height)) - Math.min(...peers.map(b => b.height));
      if (delta > 2) groups.push({parent: selector(parent), indices, delta: +delta.toFixed(2)});
    }
    return {buttons, groups};
  });
  records.push({name, folder, url: page.url(), viewport: page.viewportSize(), ...data});
  fs.writeFileSync(path.join(${JSON.stringify(out)}, ${JSON.stringify(extra ? 'measurements-extra.json' : stable ? 'measurements-stable.json' : 'measurements.json')}), JSON.stringify(records, null, 2));
  if (data.groups.length) {
    await page.screenshot({path: path.join(${JSON.stringify(out)}, 'shots', name + '.png'), fullPage: true});
  }
  console.log('measured ' + name + ': ' + data.buttons.length + ' buttons / ' + data.groups.length + ' candidate groups');
}
`;
source = source.slice(0, begin) + replacement + source.slice(end);
source = source.replace('const out = path.resolve(__dirname, "shots-final");', `const out = ${JSON.stringify(out)};`);
if (stable) {
  const overlays = source.indexOf('  /* ============ 二、');
  source = source.slice(0, overlays) + '\n await browser.close();\n})().catch(e => { console.error(e); process.exit(1); });';
  source = source.replace('await tbButton.click();', 'await tbButton.click(); await activatePickers(page); await page.waitForTimeout(1100);');
  source = source.replace('const pickers = await activatePickers(page);', 'if (tool.id === "loan_interest") { await page.goto(`${preview}/#${tool.route}`, { waitUntil: "domcontentloaded" }); await settle(page); }\n        const pickers = await activatePickers(page);');
}
if (extra) {
  source = source.replace('for (const tool of catalog) {', 'for (const tool of catalog.filter(t => ["fa_list", "fa_dep_calc", "fuzzy_match"].includes(t.id))) {');
  source = source.replace('for (const viewport of [{ width: 1600, height: 900, label: "" }, { width: 1000, height: 680, label: "@1000" }]) {', 'for (const viewport of [{ width: 1600, height: 900, label: "" }]) {');
  source = source.replace('await advanceWorkflow(page, base);', `
    if (tool.id === 'fuzzy_match') {
      const selects = page.locator('.main select:visible');
      for (let i = 0; i < await selects.count(); i++) {
        const select = selects.nth(i);
        const value = await select.evaluate(el => !el.disabled && !el.value ? [...el.options].find(o => o.value && !o.disabled)?.value : '');
        if (value) await select.selectOption(value).catch(() => {});
      }
    }
    if (tool.id === 'fa_dep_calc') {
      await page.locator('.step-indicator button').first().click();
      await capture(page, 'pages', 'fa_dep_calc-return-to-import');
    }
    await advanceWorkflow(page, base);`);
  source = source.replace('await advanceWorkflow(page, `${base}-cards`);', `
    await advanceWorkflow(page, \\u0060\${base}-cards\\u0060);
    await page.getByRole('button', {name: '有，进入补充清单', exact: true}).click();
    await capture(page, 'pages', 'fa_list-cards-supplement');
    await page.getByRole('button', {name: '无补充清单，跳过', exact: true}).click();
    await capture(page, 'pages', 'fa_list-cards-export');
  `.replaceAll('\\u0060', '\x60'));
}
// Keep live-dialog captures inside this audit as well.
const child = new Module(driverPath, module);
child.filename = driverPath;
child.paths = Module._nodeModulePaths(path.dirname(driverPath));
child._compile(source, driverPath);
