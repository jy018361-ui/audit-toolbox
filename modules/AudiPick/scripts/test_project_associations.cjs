const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(require.resolve('../audipick.html'), 'utf8');
const start = html.indexOf("var ASSOCIATION_ROLES=");
const end = html.indexOf('function ok()', start);
assert.ok(start >= 0 && end > start, 'association helpers were not found in audipick.html');

const projects = [{ id: 'p1', relationGroups: [{
    id: 'g1',
    anchorFileId: 'c1',
    members: [{ fileId: 'c2', role: '补充协议/变更' }]
  }] }];
const contracts = [
  { id: 'c1', pid: 'p1', file: '主合同.pdf', text: '---PDF第1页---\n主合同条款' },
  { id: 'c2', pid: 'p1', file: '补充协议.pdf', text: '---PDF第1页---\n补充条款' }
];
const context = {
  P: projects,
  Ct: contracts,
  V: [],
  extractCache: {},
  window: {},
  document: {},
  FieldSet: { listFieldSets: () => [] },
  gp(id) { return projects.find((x) => x.id === id); },
  gc(id) { return contracts.find((x) => x.id === id); },
  gv() { return []; },
  escapeHtml(value) { return String(value); },
  ensureModalRoot() { return {}; },
  save() {},
  render() {},
  cm() {},
  gid() { return 'generated'; }
};
vm.createContext(context);
vm.runInContext(html.slice(start, end), context);

const docs = context.associatedDocumentsFor('c1');
assert.equal(docs.length, 2);
assert.equal(docs[0].isPrimary, true);
assert.equal(docs[1].docType, '补充协议/变更');

const combined = context.buildAssociatedExtractionText('c1');
assert.match(combined, /主文件｜主合同\.pdf/);
assert.match(combined, /补充协议\/变更｜补充协议\.pdf/);
assert.match(combined, /主合同条款/);
assert.match(combined, /补充条款/);

const before = context.extractionContextFingerprint('c1');
context.Ct[1].text += '（修订）';
const after = context.extractionContextFingerprint('c1');
assert.notEqual(after, before);

const summary = context.getFileAssociationSummary('c1');
assert.equal(summary.count, 1);
assert.equal(context.associatedDocumentsFor('c2').length, 1, 'linked file remains independently extractable');

projects.push({ id: 'p2', relationGroups: [] });
contracts.push(
  { id: 'c3', pid: 'p2', file: 'A274 \u6280\u672f\u670d\u52a1\u5408\u540c.pdf', text: '\u9879\u76ee\u7f16\u53f7 A274', docLabel: '\u6536\u5165\u5408\u540c', detectedRuleId: 'revenue' },
  { id: 'c4', pid: 'p2', file: 'A274 \u9a8c\u6536\u5355.pdf', text: '\u9879\u76ee\u7f16\u53f7 A274\n\u9879\u76ee\u9a8c\u6536\u62a5\u544a', docLabel: '\u6536\u5165\u5408\u540c', detectedRuleId: 'revenue' }
);
const autoLinked = context.autoAssociateProjectFiles('p2');
assert.equal(autoLinked.length, 1, 'high-confidence project code match should auto-associate');
assert.equal(projects[1].relationGroups[0].anchorFileId, 'c3');
assert.equal(projects[1].relationGroups[0].members[0].fileId, 'c4');
assert.equal(projects[1].relationGroups[0].members[0].source, 'ai');
assert.equal(context.getFileAssociationSummary('c3').count, 1);

context.window.removeFileAssociation('c3', 'c4');
assert.equal(context.getFileAssociationSummary('c3').count, 0);
assert.equal(context.window.getAssociationSuggestion(contracts[3]), null, 'a manually removed AI association should stay dismissed');

console.log('Project association checks passed.');
