const assert = require('node:assert/strict');

global.window = global;
require('../rules/revenue_workpaper.js');

function item(sheet, no, answer, extra) {
  return Object.assign({
    workpaper_sheet: sheet,
    question_no: no,
    question_description: '',
    suggested_answer: answer,
    contract_basis: '',
    sop_basis: '',
    answer_reason: '',
    contract_excerpt: '',
    source_documents: '主合同.pdf',
    supporting_evidence: '',
    missing_information: '无',
    triggered_sheet: '无',
    appendix_status: '未触发',
    fill_readiness: '可直接填入',
    pages: '【第1页】',
    confidence: '高',
    review_status: '需人工复核'
  }, extra || {});
}

let results = RevenueWorkpaper.normalizeResults([
  item('第2步', '2.2', '否'),
  item('第2步', '2.2.1', '是')
]);
assert.equal(results.find((x) => x.question_no === '2.2.1').conditional_hidden, true);
assert.equal(RevenueWorkpaper.visibleItems(results).some((x) => x.question_no === '2.2.1'), false);
assert.equal(results.find((x) => x.question_no === '2.2').triggered_sheet, '无');

results = RevenueWorkpaper.normalizeResults([
  item('第2步', '2.2', '是'),
  item('第2步', '2.2.1', '是')
]);
assert.equal(results.find((x) => x.question_no === '2.2.1').conditional_hidden, false);
assert.equal(results.find((x) => x.question_no === '2.2.1').triggered_sheet, '2.2.1 主要责任人和代理人');

results = RevenueWorkpaper.normalizeResults([item('第1步', '1.4', '是')]);
assert.equal(results[0].triggered_sheet, '1.4 合同变更');

results = RevenueWorkpaper.normalizeResults([
  item('第1步', '1.1.1', '否', {
    contract_basis: '仅允许质量不合格产品退换货',
    contract_excerpt: '如产品存在质量问题，客户可要求退货、换货或维修。'
  })
]);
assert.match(results[0].answer_reason, /^根据我们对收入流程的了解以及对合同条款的检查/);
assert.match(results[0].answer_reason, /正常质量保证安排而非回购/);

results = RevenueWorkpaper.normalizeResults([
  item('第1步', '1.2', '是', {
    answer_reason: '合同已经双方签署；明确商品交付和付款安排；交易具有商业目的。'
  })
]);
assert.match(results[0].answer_reason, /1）合同批准及履约承诺/);
assert.match(results[0].answer_reason, /5）对价可收回性/);
assert.match(results[0].answer_reason, /无法收回对价的风险极低/);

const repeatedReason = [
  '1）合同批准及履约承诺：1）合同批准及履约承诺：1）合同各方已批准：采购订单由客户确认，工作说明和基础协议由双方签署',
  '2）各方权利和义务：2）各方权利和义务：2）各方权利义务明确：客户有权取得商品并付款，供应商负责交付并保证质量',
  '3）支付条款：3）支付条款：3）支付条款明确：验收合格后15日内付款',
  '4）商业实质：4）商业实质：4）交易用于客户自身业务并改变现金流',
  '5）对价可收回性：无法收回对价的风险极低'
].join('；') + '。';
results = RevenueWorkpaper.normalizeResults([
  item('第1步', '1.2', '是', { answer_reason: repeatedReason })
]);
for (let i = 0; i < 20; i += 1) results = RevenueWorkpaper.normalizeResults(results);
const idempotentReason = results[0].answer_reason;
assert.equal((idempotentReason.match(/1）合同批准及履约承诺/g) || []).length, 1);
assert.equal((idempotentReason.match(/2）各方权利和义务/g) || []).length, 1);
assert.equal((idempotentReason.match(/3）支付条款/g) || []).length, 1);
assert.equal((idempotentReason.match(/4）商业实质/g) || []).length, 1);
assert.equal((idempotentReason.match(/5）对价可收回性/g) || []).length, 1);
assert.match(idempotentReason, /合同各方已批准：采购订单由客户确认/);
assert.match(idempotentReason, /付款明确：验收合格后15日内付款|支付条款明确：验收合格后15日内付款/);

results = RevenueWorkpaper.applySharedFacts(results, [{
  fact_type: '付款条件',
  fact_summary: '验收合格后15日内付款',
  contract_excerpt: '客户应在验收合格后15日内支付',
  source_document: '工作说明.pdf',
  pages: '【第8页】'
}]);
assert.equal((results[0].answer_reason.match(/1）合同批准及履约承诺/g) || []).length, 1);
assert.equal((results[0].answer_reason.match(/3）支付条款/g) || []).length, 1);

results = RevenueWorkpaper.normalizeResults([
  item('第1步', '1.3', '否', {
    source_documents: '销售合同补充协议.pdf',
    contract_basis: '本补充协议对原合同付款条款进行修改。'
  })
]);
assert.match(results[0].suggested_answer, /资料不足/);
assert.match(results[0].missing_information, /原合同|主合同/);

console.log('Revenue workpaper rule checks passed.');
