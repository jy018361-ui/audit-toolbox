const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const naming = require(path.join(root, 'rules', 'export_naming.js'));

assert.equal(naming.localDateStamp(new Date(2026, 6, 31, 0, 5)), '20260731');
assert.equal(naming.sanitizeFileName(' 收入:合同/测试?.xlsx '), '收入_合同_测试_.xlsx');
assert.equal(naming.sanitizeFileName('report'), 'report.xlsx');
assert.equal(naming.sanitizeFileName('CON'), '_CON.xlsx');
assert.equal(
  naming.defaultExportName({ projectName: 'A项目', clientName: '甲公司', scopeLabel: '全部合同', typeLabel: '收入审阅', date: new Date(2026, 6, 31) }),
  'A项目_甲公司_全部合同_收入审阅_20260731.xlsx'
);
assert.equal(
  naming.defaultExportName({ fileName: '采购合同.pdf', typeLabel: '合同审阅', date: new Date(2026, 6, 31) }),
  '采购合同_合同审阅_20260731.xlsx'
);

const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'audipick.html'), 'utf8');
assert.match(main, /backgroundThrottling:\s*false/);
const desktopFetchHandler = main.slice(main.indexOf("ipcMain.handle('desktop-fetch'"), main.indexOf("ipcMain.handle('desktop-ping'"));
assert.doesNotMatch(desktopFetchHandler, /win\.focus\(\)/);
assert.match(html, /await dbPutPdf\(fid,file\);\s*await persistOcrResumeTask\(resumeTask\);\s*var result=await processPDF/);
assert.match(html, /resumeTask\.completedPages=completedPages/);
assert.match(html, /if\(!pageFailed\)\{completedPages\[i\]=body\|\|''/);
assert.match(html, /resumeTask\.resultText=fullText/);
assert.match(html, /window\.resumeOcrTask=async function/);
assert.match(html, /await save\(\);\s*await removeOcrResumeTask/);
assert.match(html, /requestExcelFileName\(fname/);
assert.doesNotMatch(html, /new Date\(\)\.toISOString\(\)\.split\('T'\)\[0\]+'\.xlsx'/);

console.log('background resume and export naming tests passed');
