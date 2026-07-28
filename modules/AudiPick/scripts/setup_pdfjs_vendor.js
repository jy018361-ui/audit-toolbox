// Copy pdfjs-dist assets into vendor/pdfjs for offline Electron (file://) loading
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'node_modules', 'pdfjs-dist');
const DEST = path.join(ROOT, 'vendor', 'pdfjs');

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name);
    const to = path.join(dest, name);
    if (fs.statSync(from).isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

if (!fs.existsSync(SRC)) {
  console.error('pdfjs-dist not found. Run: npm install');
  process.exit(1);
}

fs.mkdirSync(DEST, { recursive: true });
copyDir(path.join(SRC, 'legacy', 'build'), path.join(DEST, 'legacy', 'build'));
copyDir(path.join(SRC, 'cmaps'), path.join(DEST, 'cmaps'));
copyDir(path.join(SRC, 'standard_fonts'), path.join(DEST, 'standard_fonts'));

console.log('pdfjs vendor assets ready at vendor/pdfjs/');

// xlsx-js-style (SheetJS fork with cell styles) for offline Excel export
const xlsxCandidates = [
  path.join(ROOT, 'node_modules', 'xlsx-js-style', 'dist', 'xlsx.bundle.js'),
  path.join(ROOT, 'node_modules', 'xlsx', 'dist', 'xlsx.full.min.js')
];
const xlsxDestDir = path.join(ROOT, 'vendor', 'xlsx');
const xlsxSrc = xlsxCandidates.find(function (p) { return fs.existsSync(p); });
if (xlsxSrc) {
  fs.mkdirSync(xlsxDestDir, { recursive: true });
  fs.copyFileSync(xlsxSrc, path.join(xlsxDestDir, 'xlsx.full.min.js'));
  console.log('xlsx vendor asset ready at vendor/xlsx/ (from ' + path.relative(ROOT, xlsxSrc) + ')');
} else {
  console.warn('xlsx-js-style/xlsx not found in node_modules; Excel export may fail offline');
}
