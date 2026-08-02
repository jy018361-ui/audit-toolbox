const assert = require('node:assert/strict');
const LoanAudit = require('../rules/loan_audit.js');

function loan(id, contractId, values) {
  return Object.assign({
    id,
    contractId,
    ruleId: 'loan_general',
    contract_no: id,
    borrower: '测试借款人',
    lender: '测试银行',
    currency: '人民币',
    contract_principal: '人民币100万元',
    signing_date: '2026-01-10',
    loan_start_date: '2026-01-15',
    maturity_date: '2026-12-31',
    interest_rate: '固定年利率3.2%',
    repayment_method: '到期一次还本',
    repayment_schedule: '到期一次还本',
    loan_nature: '信用',
    guarantor: '不适用',
    security_summary: '不适用',
    covenant_summary: '未发现明确限制性契约'
  }, values || {});
}

const context = {
  project: { id: 'p1', name: '借款审计测试', date: '2026-12-31', loanReportDate: '2026-12-31' },
  contracts: [
    { id: 'main-a', file: '人民币借款合同.pdf' },
    { id: 'main-b', file: '美元借款合同.pdf' },
    { id: 'child-a', file: '人民币借款合同-保证附件.pdf' }
  ],
  relationGroups: [{
    id: 'g1',
    anchorFileId: 'main-a',
    members: [{ fileId: 'child-a', role: '其他支持文件' }]
  }],
  results: [
    loan('CNY-01', 'main-a', {
      contract_principal: '人民币1,200万元',
      loan_start_date: '2026-01-01',
      maturity_date: '2026-12-31',
      repayment_method: '分期还本',
      repayment_schedule: '在借款存续期内每季度末偿还本金'
    }),
    loan('CNY-02', 'main-a', {
      contract_principal: '人民币300万元',
      signing_date: '2025-12-20',
      loan_start_date: '2026-02-01',
      maturity_date: '2027-02-01'
    }),
    loan('USD-01', 'main-b', {
      currency: '美元',
      contract_principal: 'USD 20万美元',
      signing_date: '2026年3月1日',
      loan_start_date: '2025-03-01',
      maturity_date: '2027-03-01'
    }),
    loan('CHILD-EXCLUDED', 'child-a', {
      contract_principal: '人民币9,999万元'
    })
  ]
};

const model = LoanAudit.buildModel(context);

// 一份主文件可以形成多债项，但关联子文件不得形成独立债项。
assert.equal(model.debts.length, 3);
assert.equal(model.counts.contractCount, 2);
assert.equal(model.counts.associatedExcluded, 1);
assert.equal(model.debts.some((debt) => debt.contractId === 'child-a'), false);
assert.deepEqual(model.debts.filter((debt) => debt.contractId === 'main-a').map((debt) => debt.contractNo), ['CNY-01', 'CNY-02']);

// 分币种统计保持独立，不做汇率折算，也不纳入关联子文件金额。
assert.equal(model.currencyTotals.CNY, 15_000_000);
assert.equal(model.currencyTotals.USD, 200_000);
assert.equal(Object.keys(model.currencyTotals).length, 2);

// 报告年度内签署和生效分别判断。
assert.equal(model.counts.newSigned, 2);
assert.equal(model.counts.newEffective, 2);
assert.equal(model.debts.find((debt) => debt.id === 'CNY-01').newSigned, true);
assert.equal(model.debts.find((debt) => debt.id === 'CNY-02').newSigned, false);
assert.equal(model.debts.find((debt) => debt.id === 'CNY-02').newEffective, true);

// “每季度末”映射至3/6/9/12月，但不得把合同本金平均分摊到季度。
const quarterlyDebt = model.debts.find((debt) => debt.id === 'CNY-01');
assert.deepEqual(quarterlyDebt.repayment.rows.map((row) => row.date), [
  '2026-03-31', '2026-06-30', '2026-09-30', '2026-12-31'
]);
assert.equal(quarterlyDebt.repayment.rows.every((row) => row.amount === null), true);
assert.equal(model.monthlyMatrix.rows.find((row) => row.debtId === 'CNY-01').cells['2026-03'].hasUncertain, true);

// 没有明确起止日的“每季度末”不得展开。
const unclearQuarter = LoanAudit.buildModel({
  project: { loanReportDate: '2026-12-31' },
  contracts: [{ id: 'main-c', file: '期限待明确合同.pdf' }],
  relationGroups: [],
  results: [loan('CNY-03', 'main-c', {
    loan_start_date: '未明确',
    maturity_date: '未明确',
    repayment_method: '分期还本',
    repayment_schedule: '每季度末偿还本金'
  })]
});
assert.equal(unclearQuarter.repaymentPlan.length, 0);
assert.equal(unclearQuarter.debts[0].repayment.status, '待明确');
assert.equal(unclearQuarter.validations.some((item) => item.code === 'quarter_range_missing'), true);

// 页面与固定 API 可直接接入主页面。
const html = LoanAudit.renderPage(context);
assert.match(html, /借款审计中心/);
assert.match(html, /驾驶舱/);
assert.equal(typeof LoanAudit.exportExcel, 'function');
assert.equal(global.LoanAudit, LoanAudit);
assert.equal(typeof global.loanAuditSetReportDate, 'function');

// 明确“每季度末偿还500万元”只在3/6/9/12月各形成一笔，不向季度内月份分摊。
const amountQuarter = LoanAudit.buildModel({
  project: { loanReportDate: '2025-12-31' },
  contracts: [{ id: 'main-d', file: '季度还款合同.pdf', ruleId: 'loan_general' }],
  relationGroups: [],
  results: [loan('CNY-04', 'main-d', {
    contract_principal: '人民币2,000万元',
    loan_start_date: '2025-01-01',
    maturity_date: '2025-12-31',
    repayment_method: '分期还本',
    repayment_schedule: '每季度末偿还500万元本金'
  })]
});
assert.deepEqual(amountQuarter.repaymentPlan.map((row) => [row.date, row.amount]), [
  ['2025-03-31', 5_000_000], ['2025-06-30', 5_000_000], ['2025-09-30', 5_000_000], ['2025-12-31', 5_000_000]
]);
assert.equal(amountQuarter.monthlyMatrix.rowByDebtId['CNY-04'].cells['2025-01'], undefined);
assert.equal(amountQuarter.monthlyMatrix.rowByDebtId['CNY-04'].cells['2025-03'].amount, 5_000_000);

// 仅写“每季度”但没有季末/季初/具体月份时，不得擅自映射月份。
const vagueQuarter = LoanAudit.buildModel({
  project: { loanReportDate: '2025-12-31' },
  contracts: [{ id: 'main-e', file: '季度月份待定合同.pdf', ruleId: 'loan_general' }],
  relationGroups: [],
  results: [loan('CNY-05', 'main-e', {
    loan_start_date: '2025-01-01', maturity_date: '2025-12-31', repayment_method: '分期还本',
    repayment_schedule: '每季度偿还500万元本金，具体月份待明确'
  })]
});
assert.equal(vagueQuarter.repaymentPlan.length, 0);

// 报告日后的同年度合同不能标记为本年新签，并应产生期后提示。
const afterReport = LoanAudit.buildModel({
  project: { loanReportDate: '2026-06-30' },
  contracts: [{ id: 'main-f', file: '期后合同.pdf', ruleId: 'loan_general' }],
  relationGroups: [],
  results: [loan('CNY-06', 'main-f', { signing_date: '2026-08-01', loan_start_date: '2026-08-02' })]
});
assert.equal(afterReport.counts.newSigned, 0);
assert.equal(afterReport.validations.some((item) => item.code === 'signed_after_report_date'), true);

// 同一主文件保留最新字段版本，避免历史底稿版本重复形成卡片。
const latestOnly = LoanAudit.buildModel({
  project: { loanReportDate: '2026-12-31' },
  contracts: [{ id: 'main-g', file: '多版本合同.pdf', ruleId: 'loan_general' }],
  relationGroups: [],
  results: [
    loan('OLD', 'main-g', { fieldSetId: 'old', extractAt: '2026-01-01T00:00:00Z' }),
    loan('NEW', 'main-g', { fieldSetId: 'new', extractAt: '2026-02-01T00:00:00Z' })
  ]
});
assert.deepEqual(latestOnly.debts.map((debt) => debt.contractNo), ['NEW']);

const repaymentHtml = LoanAudit.renderPage(Object.assign({}, context));
global.loanAuditSetView('repayment');
const monthlyHtml = LoanAudit.renderPage(context);
assert.match(monthlyHtml, /还款月份/);
assert.match(monthlyHtml, /按月还本矩阵 · 人民币/);
assert.match(monthlyHtml, /按月还本矩阵 · 美元/);
assert.equal(repaymentHtml.includes('还款月份'), false);

console.log('loan audit rules: ok');
