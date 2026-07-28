const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const attrs = {};
const storage = {};
const modalRoot = { innerHTML: '' };
global.window = global;
global.localStorage = {
  getItem(key) { return storage[key] || null; },
  setItem(key, value) { storage[key] = String(value); }
};
global.document = {
  documentElement: {
    getAttribute(key) { return attrs[key] || null; },
    setAttribute(key, value) { attrs[key] = String(value); }
  },
  getElementById(id) { return id === 'modal-root' ? modalRoot : null; },
  querySelectorAll() { return []; }
};

require('../rules/theme.js');

const expectedIds = [
  'classic-dark', 'yellow-light', 'blue-white', 'red-white',
  'yellow-blue', 'red-yellow-ivory', 'yellow-green', 'teal-dark'
];
assert.deepEqual(ThemeManager.themes.map((theme) => theme.id), expectedIds);

function luminance(hex) {
  const value = hex.replace('#', '');
  const channels = [0, 2, 4].map((index) => parseInt(value.slice(index, index + 2), 16) / 255);
  const linear = channels.map((channel) => channel <= 0.04045
    ? channel / 12.92
    : Math.pow((channel + 0.055) / 1.055, 2.4));
  return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
}

function contrast(first, second) {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

ThemeManager.themes.forEach((theme) => {
  const palette = theme.palette;
  const pairs = [
    ['正文/页面背景', palette.text, palette.appBg],
    ['正文/卡片背景', palette.text, palette.surface],
    ['次要文字/页面背景', palette.muted, palette.appBg],
    ['按钮文字/强调色', palette.accentText, palette.accent],
    ['强调文字/页面背景', palette.accentInk, palette.appBg],
    ['强调文字/卡片背景', palette.accentInk, palette.surface],
    ['侧栏正文/侧栏背景', palette.sidebarText, palette.sidebar],
    ['侧栏次要文字/侧栏背景', palette.sidebarMuted, palette.sidebar],
    ['侧栏强调文字/侧栏背景', palette.sidebarAccent, palette.sidebar]
  ];
  pairs.forEach(([label, foreground, background]) => {
    assert.ok(contrast(foreground, background) >= 4.5, `${theme.name} ${label} 对比度不足`);
  });
  ThemeManager.apply(theme.id);
  assert.equal(attrs['data-theme'], theme.id);
  assert.equal(storage.ap_theme, theme.id);
});

ThemeManager.open();
assert.equal((modalRoot.innerHTML.match(/data-theme-option=/g) || []).length, expectedIds.length);
ThemeManager.themes.forEach((theme) => assert.match(modalRoot.innerHTML, new RegExp(theme.name)));

const html = fs.readFileSync(path.join(__dirname, '..', 'audipick.html'), 'utf8');
assert.match(html, /id="theme-settings-button"/);
assert.match(html, /onclick="openThemeSettings\(\)"/);
expectedIds.forEach((id) => assert.match(html, new RegExp(`data-theme="${id}"`)));

console.log('Theme checks passed.');
