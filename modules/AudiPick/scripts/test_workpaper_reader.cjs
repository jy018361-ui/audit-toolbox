const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'audipick.html'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'rules', 'ui.js'), 'utf8');

function functionSource(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const braceStart = html.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = braceStart; index < html.length; index += 1) {
    const char = html[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return html.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

assert.match(html, /\.workpaper-reader-grid\{display:grid/);
assert.match(html, /\.workpaper-list-scroll thead\{position:sticky/);
assert.match(html, /\.workpaper-detail-scroll\{height:100%;min-height:0;overflow-y:auto/);
assert.match(html, /detail\.scrollTop=0;rememberWorkpaperReaderScroll\('detail',0\)/);
assert.match(html, /list\.scrollTop=listTop;rememberWorkpaperReaderScroll\('list',listTop\)/);
assert.match(html, /currentPdfSourceId=sourceId/);
assert.match(html, /currentPdfPage=targetPage!==null\?targetPage:1/);
assert.match(html, /pendingPdfTargetPage=currentPdfPage;currentPdfDoc=null/);
assert.match(html, /var targetPage = pendingPdfTargetPage \|\| currentPdfPage \|\| 1/);
assert.match(html, /if\(loadToken !== pdfLoadToken\) return/);
assert.match(ui, /parseEvidenceRefs\(item\)/);
assert.ok(ui.includes("ref.source_id || ref.sourceId"));
assert.ok(ui.includes("inlineJsValue(ref.source)"));
assert.ok(ui.includes("inlineJsValue(ref.pages)"));
assert.ok(ui.includes("inlineJsValue(ref.sourceId)"));
assert.ok(ui.includes("inlineJsValue(item.id || '')"));
assert.match(ui, /function compactEvidencePageText\(value\)/);
assert.doesNotMatch(ui, /跳转到 PDF/);
assert.doesNotMatch(html, /该引用来自完整资料包，请选择要查看的文件/);
assert.match(html, /function autoResolveEvidenceSourceId\(contract,sourceName,pageStr,sourceId,itemId\)/);

const context = {
  V: [
    {
      id: 'item-order',
      contract_excerpt: '客户验收合格后出具验收单，供应商随后确认收入。',
      contract_basis: '',
      supporting_evidence: '',
      answer_reason: '',
      question_description: ''
    }
  ],
  associatedDocumentsFor() {
    return [
      { id: 'main-id', name: '主合同.pdf', isPrimary: true, text: '---PDF第1页---\n主合同一般条款\n---PDF第4页---\n付款安排' },
      { id: 'order-id', name: '订单附件.pdf', isPrimary: false, text: '---PDF第1页---\n订单说明\n---PDF第4页---\n客户验收合格后出具验收单，供应商随后确认收入。' }
    ];
  }
};
vm.createContext(context);
[
  'compactEvidencePageLabel',
  'parsePageNumber',
  'isSyntheticEvidenceSource',
  'normalizedEvidenceSourceName',
  'evidenceSourceRecords',
  'resolveEvidenceSourceId',
  'evidencePageOptions',
  'evidenceItemSearchText',
  'autoResolveEvidenceSourceId'
].forEach((name) => vm.runInContext(functionSource(name), context));
const matcherStart = html.indexOf('function normalizedEvidenceMatchText(');
const matcherEnd = html.indexOf('function resolveRevenueFactDocument(', matcherStart);
assert.notEqual(matcherStart, -1);
assert.notEqual(matcherEnd, -1);
vm.runInContext(html.slice(matcherStart, matcherEnd), context);

assert.equal(context.compactEvidencePageLabel('完整合同资料包（1份文件） · 【第1页】'), '第1页');
assert.equal(context.compactEvidencePageLabel('订单附件.pdf · 【第2-4页】'), '第2–4页');
assert.equal(context.compactEvidencePageLabel('【页码未知】'), '页码未知');

const contract = { id: 'main-id', file: '主合同.pdf', supplements: [] };
assert.equal(context.resolveEvidenceSourceId(contract, '完整合同资料包（1份文件）'), 'main-id');
assert.equal(context.resolveEvidenceSourceId(contract, '完整合同资料包（2份文件）'), 'main-id');
assert.equal(context.resolveEvidenceSourceId(contract, '订单附件.pdf'), 'order-id');
assert.equal(context.resolveEvidenceSourceId(contract, '订单附件'), 'order-id');
assert.equal(context.resolveEvidenceSourceId(contract, '不存在.pdf'), null);
assert.deepEqual(Array.from(context.evidencePageOptions('【第3页】；【第7-8页】')), ['【第3页】', '【第7-8页】']);
assert.equal(context.compactEvidencePageLabel('【第7至8页】'), '第7–8页');
assert.equal(context.autoResolveEvidenceSourceId(contract, '完整合同资料包（2份文件）', '【第4页】', '', 'item-order'), 'order-id');
assert.equal(context.autoResolveEvidenceSourceId(contract, '完整合同资料包（2份文件）', '【第1页】', 'main-id', 'item-order'), 'main-id');
assert.equal(context.autoResolveEvidenceSourceId(contract, '订单附件.pdf', '【第4页】', '', 'item-order'), 'order-id');

console.log('workpaper reader tests passed');
