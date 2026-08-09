const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(require.resolve('../audipick.html'), 'utf8');
const start = html.indexOf('function touchProject(projectId)');
const end = html.indexOf('function projectFileCheckboxHtml', start);
assert.ok(start >= 0 && end > start, 'project dashboard helpers were not found');

const projects = [
  { id: 'p1', name: '收入项目', client: '甲公司', date: '2026-06-30', status: 'active', t: '2026-01-01T00:00:00Z', relationGroups: [{ anchorFileId: 'c1', members: [{ fileId: 'c2' }] }] },
  { id: 'p2', name: '借款项目', client: '乙公司', date: '2026-12-31', status: 'completed', t: '2026-02-01T00:00:00Z', relationGroups: [] }
];
const contracts = [
  { id: 'c1', pid: 'p1', t: '2026-01-02T00:00:00Z' },
  { id: 'c2', pid: 'p1', t: '2026-01-03T00:00:00Z' },
  { id: 'c3', pid: 'p2', t: '2026-02-02T00:00:00Z' }
];
const results = [
  { id: 'v1', contractId: 'c1', ruleId: 'revenue', fieldSetId: 'fs1', extractAt: '2026-03-01T00:00:00Z', reviewed: false },
  { id: 'v2', contractId: 'c2', ruleId: 'revenue', fieldSetId: 'fs2', extractAt: '2026-03-02T00:00:00Z', reviewed: true },
  { id: 'v3', contractId: 'c3', ruleId: 'loan_general', fieldSetId: 'fs3', extractAt: '2026-04-01T00:00:00Z', reviewed: true }
];
let confirmCalls = 0;
const storage = {};
const context = {
  P: projects,
  Ct: contracts,
  V: results,
  projectViewPrefs: { search: '', status: 'all', sort: 'updated_desc' },
  projectSearchTimer: null,
  window: {},
  localStorage: { setItem(key, value) { storage[key] = value; } },
  FieldSet: {
    latestFieldSetId(contractId, ruleId) { const item = results.find((value) => value.contractId === contractId && value.ruleId === ruleId); return item && item.fieldSetId; },
    gvFieldSet(contractId, ruleId, fieldSetId) { return results.filter((value) => value.contractId === contractId && value.ruleId === ruleId && value.fieldSetId === fieldSetId); }
  },
  gp(id) { return projects.find((project) => project.id === id); },
  gc(id) { return contracts.find((contract) => contract.id === id); },
  gv(id) { return results.filter((result) => result.contractId === id); },
  gvRule(id, ruleId) { return results.filter((result) => result.contractId === id && result.ruleId === ruleId); },
  getAppliedRuleIds(id) { return [...new Set(results.filter((result) => result.contractId === id).map((result) => result.ruleId))]; },
  RuleEngine: { getRuleShortName(value) { return value; } },
  confirm() { confirmCalls++; return true; },
  save() {},
  render() {},
  setTimeout,
  clearTimeout
};

vm.createContext(context);
vm.runInContext(html.slice(start, end), context);

const progress = context.projectProgressInfo(projects[0]);
assert.equal(progress.rootCount, 1, '关联子文件不应重复计入主合同进度');
assert.equal(progress.extracted, 1);
assert.equal(progress.reviewTotal, 1, '关联子文件的独立结果不应进入主合同复核分母');
assert.equal(progress.phase, '待复核');

assert.equal(context.projectLastActivity(projects[0]), Date.parse('2026-03-02T00:00:00Z'));

context.projectViewPrefs.status = 'active';
assert.deepEqual(context.projectDashboardRows().map((row) => row.project.id), ['p1']);
context.projectViewPrefs.status = 'all';
context.projectViewPrefs.search = '借款';
assert.deepEqual(context.projectDashboardRows().map((row) => row.project.id), ['p2']);
context.projectViewPrefs.search = '';
context.projectViewPrefs.sort = 'created_asc';
assert.deepEqual(context.projectDashboardRows().map((row) => row.project.id), ['p1', 'p2']);

context.window.setProjectStatus('p1', 'completed');
assert.equal(projects[0].status, 'completed');
assert.equal(confirmCalls, 1, '未完成复核时应提示但允许用户自行完成项目');
assert.ok(projects[0].updatedAt);

console.log('Project dashboard checks passed.');
