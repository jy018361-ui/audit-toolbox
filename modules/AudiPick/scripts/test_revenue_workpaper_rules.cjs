const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

global.window = global;
require('../rules/revenue_workpaper.js');
global.RULE_PROMPTS = {};
require('../rules/prompts/revenue_workpaper.js');
const appHtml = fs.readFileSync(path.resolve(__dirname, '..', 'audipick.html'), 'utf8');
const uiSource = fs.readFileSync(path.resolve(__dirname, '..', 'rules', 'ui.js'), 'utf8');

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

function json(value) {
  return JSON.stringify(value);
}

function planSheets(items) {
  return RevenueWorkpaper.buildAppendixPlan(items).map((entry) => entry.display_name);
}

const generalInfoQuestions = RevenueWorkpaper.questions.slice(0, 5);
assert.deepEqual(generalInfoQuestions.map((entry) => entry.questionNo), ['GI.1', 'GI.2', 'GI.3', 'GI.4', 'GI.5']);
assert.deepEqual(generalInfoQuestions.map((entry) => entry.question), [
  '客户名称', '法人实体（卖方）', '合同号', '合同计价货币', '合同开始日期'
]);
assert.deepEqual(generalInfoQuestions.map((entry) => entry.answerCell), ['D2', 'D3', 'D4', 'D5', 'D6']);
assert.match(RULE_PROMPTS.revenue_workpaper, /一般合同信息填列要求/);
assert.match(REVENUE_FACT_PROMPT, /fact_type必须逐字使用“客户名称”/);
assert.match(appHtml, /\['GI\.1','GI\.2','GI\.3','GI\.4','GI\.5'\]/);
assert.match(appHtml, /sourceResolutionVersion===3/);
assert.match(appHtml, /hasGeneralInformation\(cachedItems\)/);
assert.match(appHtml, /extractTriggeredAppendixRound/);
assert.match(appHtml, /extractPoTimingAssessments/);
assert.match(appHtml, /groupRevenueDetailQuestions/);
assert.match(appHtml, /completeRevenueQuestionBatch/);
assert.match(appHtml, /revenueMissingQuestionFallback/);
assert.doesNotMatch(appHtml, /底稿第'\+\(index\+1\)\+'组仍缺少问题/);
assert.doesNotMatch(appHtml, /\['5\.1','5\.2'/);
assert.match(uiSource, /display_question_no/);
assert.match(uiSource, /display_question_description/);
assert.match(uiSource, /本表分析对象/);

let generalResults = RevenueWorkpaper.normalizeResults([
  item('第1步', '1.1', '是'),
  item('第1部分——一般合同信息', 'GI.2', '乙公司'),
  item('第1部分——一般合同信息', 'GI.1', '甲公司'),
  item('第1部分——一般合同信息', 'GI.3', 'N/A'),
  item('第1部分——一般合同信息', 'GI.4', '美元'),
  item('第1部分——一般合同信息', 'GI.5', '2026-01-01')
]);
assert.deepEqual(generalResults.slice(0, 5).map((entry) => entry.question_no), ['GI.1', 'GI.2', 'GI.3', 'GI.4', 'GI.5']);
assert.equal(RevenueWorkpaper.hasGeneralInformation(generalResults), true);
assert.equal(RevenueWorkpaper.hasGeneralInformation(generalResults.slice(1)), false);
assert.equal(generalResults[0].sop_basis, 'SOP > 第一步：识别客户合同');
const generalChecklist = RevenueWorkpaper.buildChecklistRows({ file: '收入合同.pdf' }, generalResults);
assert.deepEqual(generalChecklist.slice(0, 5).map((row) => row['问题描述']), [
  '客户名称', '法人实体（卖方）', '合同号', '合同计价货币', '合同开始日期'
]);
assert.deepEqual(generalChecklist.slice(0, 5).map((row) => row['回答目标单元格']), ['D2', 'D3', 'D4', 'D5', 'D6']);

// A model may return a descriptive sheet title while keeping the unique main
// question number. Normalize it to the canonical template sheet before the
// batch-completeness check so an answered group is not reported as wholly
// missing.
const descriptiveSheetResult = RevenueWorkpaper.normalizeResults([
  item('第一步：识别客户合同', '1.1', '是')
]);
assert.equal(descriptiveSheetResult[0].workpaper_sheet, '第1步');
assert.equal(descriptiveSheetResult[0].question_no, '1.1');

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

results = RevenueWorkpaper.normalizeResults([
  item('第2步', '2.2', '是'),
  item('第2步', '2.2.1', '否')
]);
assert.equal(results.find((x) => x.question_no === '2.2.1').conditional_hidden, false);
assert.equal(results.find((x) => x.question_no === '2.2.1').triggered_sheet, '无');
assert.equal(RevenueWorkpaper.buildAppendixPlan(results).some((entry) => entry.template_sheet === '2.2.1 PVA'), false);

results = RevenueWorkpaper.normalizeResults([item('第1步', '1.4', '是')]);
assert.equal(results[0].triggered_sheet, '1.4 合同变更');

// 2.1 must distinguish the three workbook answers. A single good/service does
// not need the detail sheet, while both kinds of compound answers do.
[
  ['单项履约义务 - 单个商品或服务', false],
  ['单项履约义务 - 多个商品和/或服务', true],
  ['多项履约义务', true]
].forEach(([answer, shouldTrigger]) => {
  const normalized = RevenueWorkpaper.normalizeResults([
    item('第2步', '2.1', answer, {
      triggered_sheet: 'AI伪造的附表名称'
    })
  ]);
  assert.equal(normalized[0].triggered_sheet, shouldTrigger ? '2.1 履约义务' : '无');
  assert.equal(planSheets(normalized).includes('2.1 履约义务'), shouldTrigger);
});

// Multiple principal/agent subjects create independent PVA analyses. Repeated
// subject IDs are de-duplicated within the same template.
results = RevenueWorkpaper.normalizeResults([
  item('第2步', '2.2', '是'),
  item('第2步', '2.2.1', '是', {
    appendix_subjects: json([
      {
        subject_id: 'PVA-01',
        template_sheet: '2.2.1 PVA',
        instance_no: 1,
        subject: '设备交付',
        display_name: '2.2.1 PVA-设备交付',
        source_question: '2.2.1'
      },
      {
        subject_id: 'PVA-02',
        template_sheet: '2.2.1 PVA',
        instance_no: 2,
        subject: '安装服务',
        display_name: '2.2.1 PVA-安装服务',
        source_question: '2.2.1'
      },
      {
        subject_id: 'PVA-02',
        template_sheet: '2.2.1 PVA',
        instance_no: 3,
        subject: '安装服务重复项',
        display_name: '2.2.1 PVA-安装服务重复项',
        source_question: '2.2.1'
      }
    ])
  })
]);
let plan = RevenueWorkpaper.buildAppendixPlan(results);
let pvaPlan = plan.filter((entry) => entry.template_sheet === '2.2.1 PVA');
assert.equal(pvaPlan.length, 2);
assert.deepEqual(pvaPlan.map((entry) => entry.subject_id), ['PVA-01', 'PVA-02']);
assert.deepEqual(pvaPlan.map((entry) => entry.display_name), [
  '2.2.1 主要责任人和代理人-设备交付',
  '2.2.1 主要责任人和代理人-安装服务'
]);
assert.match(results.find((x) => x.question_no === '2.2.1').triggered_sheet, /设备交付/);
assert.match(results.find((x) => x.question_no === '2.2.1').triggered_sheet, /安装服务/);

// Two independent variable-consideration mechanisms create two 3.2 sheets.
// The same rebate may also require one 3.5 analysis, but repeated structured
// entries must not create duplicate sheets or duplicate transaction-price work.
results = RevenueWorkpaper.normalizeResults([
  item('第3步', '3.1', '否（可变对价）—继续第3.2步'),
  item('第3步', '3.2', '是', {
    contract_basis: '合同包含销售返利和退货权。',
    appendix_subjects: json([
      {
        subject_id: 'VC-01',
        template_sheet: '3.2 可变对价',
        instance_no: 1,
        subject: '销售返利',
        display_name: '3.2 可变对价-销售返利',
        source_question: '3.2'
      },
      {
        subject_id: 'VC-02',
        template_sheet: '3.2 可变对价',
        instance_no: 2,
        subject: '退货权',
        display_name: '3.2 可变对价-退货权',
        source_question: '3.2'
      },
      {
        subject_id: 'VC-01',
        template_sheet: '3.2 可变对价',
        instance_no: 3,
        subject: '销售返利重复项',
        display_name: '3.2 可变对价-销售返利重复项',
        source_question: '3.2'
      }
    ])
  }),
  item('第3步', '3.5', '是', {
    appendix_subjects: json([
      {
        subject_id: 'PC-01',
        template_sheet: '3.5 客户对价',
        instance_no: 1,
        subject: '销售返利',
        display_name: '3.5 应付客户对价-销售返利',
        source_question: '3.5',
        related_subject_id: 'VC-01'
      },
      {
        subject_id: 'PC-01',
        template_sheet: '3.5 客户对价',
        instance_no: 2,
        subject: '销售返利',
        display_name: '3.5 应付客户对价-销售返利重复项',
        source_question: '3.5',
        related_subject_id: 'VC-01'
      }
    ])
  })
]);
plan = RevenueWorkpaper.buildAppendixPlan(results);
const variablePlan = plan.filter((entry) => entry.template_sheet === '3.2 可变对价');
const customerPlan = plan.filter((entry) => entry.template_sheet === '3.5 客户对价');
assert.equal(variablePlan.length, 2);
assert.deepEqual(variablePlan.map((entry) => entry.subject_id), ['VC-01', 'VC-02']);
assert.equal(customerPlan.length, 1);
assert.equal(customerPlan[0].trigger_question, '3.5');
assert.equal(customerPlan[0].subject_id, 'PC-01');
assert.equal(customerPlan[0].related_subject_id, 'VC-01');
assert.equal(customerPlan[0].subject_name, '销售返利');

// Service warranties and material rights can add PO records without inventing
// a 2.4 appendix. PO numbers must remain continuous and unique.
const obligationsInput = [
  item('第2步', '2.1', '多项履约义务', {
    performance_obligations: json([
      { po_no: 'PO#1', name: '设备交付', source_question: '2.1' },
      { po_no: 'PO#2', name: '安装服务', source_question: '2.1' }
    ])
  }),
  item('第2步', '2.3', '是', {
    performance_obligations: json([
      { po_no: 'PO#3', name: '延长质保服务', source_question: '2.3' }
    ])
  }),
  item('第2步', '2.4', '是', {
    performance_obligations: json([
      { po_no: 'PO#4', name: '续约重大权利', source_question: '2.4' }
    ]),
    triggered_sheet: '2.4 重大权利'
  })
];
const obligations = RevenueWorkpaper.buildPerformanceObligations(obligationsInput);
assert.deepEqual(obligations.map((po) => po.po_no), [1, 2, 3, 4]);
assert.deepEqual(obligations.map((po) => po.source_question), ['2.1', '2.1', '2.3', '2.4']);
results = RevenueWorkpaper.normalizeResults(obligationsInput);
assert.equal(results.find((x) => x.question_no === '2.3').triggered_sheet, '2.3 质保');
assert.equal(results.find((x) => x.question_no === '2.4').triggered_sheet, '无');
assert.equal(RevenueWorkpaper.buildAppendixPlan(results).some((entry) => entry.template_sheet === '2.4 重大权利'), false);

// Distinct warranty promises create separate appendix instances. This prevents
// repair-service warranties and repair-part warranties from being mixed into
// one answer, as can happen in a multi-obligation repair-service review.
results = RevenueWorkpaper.normalizeResults([
  item('第2步', '2.3', '是', {
    appendix_subjects: json([
      { subject_id: 'WAR-01', template_sheet: '2.3 质保', instance_no: 1, subject: '修复产品12个月免费保固及额外12个月保修服务', source_question: '2.3' },
      { subject_id: 'WAR-02', template_sheet: '2.3 质保', instance_no: 2, subject: '维修料件90天保固', source_question: '2.3' }
    ])
  })
]);
const warrantyPlan = RevenueWorkpaper.buildAppendixPlan(results).filter((entry) => entry.template_sheet === '2.3 质保');
assert.deepEqual(warrantyPlan.map((entry) => entry.subject_id), ['WAR-01', 'WAR-02']);
assert.equal(new Set(warrantyPlan.map((entry) => entry.display_name)).size, 2);
const warrantyDetailQuestions = RevenueWorkpaper.buildTriggeredDetailQuestions(results);
assert.equal(new Set(warrantyDetailQuestions.map((entry) => entry.sheet)).size, 2);
assert.equal(warrantyDetailQuestions.some((entry) => entry.questionNo === '2.3-W3'), false);

// Each PO gets exactly one recognition-timing sheet. Any affirmative criterion
// means over-time; all three negative criteria mean point-in-time. When the
// model returns an uncertainty state without a reliable direction, the answer
// remains blank and no recognition-timing sheet is guessed.
const poList = json([
  { po_no: 'PO#1', name: '持续运维服务', source_question: '2.1' },
  { po_no: 'PO#2', name: '设备交付', source_question: '2.1' },
  { po_no: 'PO#3', name: '待补资料事项', source_question: '2.1' }
]);
results = RevenueWorkpaper.normalizeResults([
  item('第2步', '2.1', '多项履约义务', { performance_obligations: poList }),
  item('第5a步（PO#1）', '5.1', '是', {
    over_time_criteria: json([
      { po_no: 'PO#1', criterion_no: '1', result: '是', basis: '客户同步取得服务利益' },
      { po_no: 'PO#1', criterion_no: '2', result: '否', basis: '未形成客户控制资产' },
      { po_no: 'PO#1', criterion_no: '3', result: '否', basis: '不适用' }
    ]),
    triggered_sheet: '5.1.2 时点（PO#1）'
  }),
  item('第5a步（PO#2）', '5.1', '否', {
    over_time_criteria: json([
      { po_no: 'PO#2', criterion_no: '1', result: '否', basis: '否' },
      { po_no: 'PO#2', criterion_no: '2', result: '否', basis: '否' },
      { po_no: 'PO#2', criterion_no: '3', result: '否', basis: '否' }
    ]),
    triggered_sheet: '5.1.1 时段（PO#2）'
  }),
  item('第5a步（PO#3）', '5.1', '资料不足', {
    over_time_criteria: json([
      { po_no: 'PO#3', criterion_no: '1', result: '否', basis: '否' },
      { po_no: 'PO#3', criterion_no: '2', result: '否', basis: '否' },
      { po_no: 'PO#3', criterion_no: '3', result: '资料不足', basis: '缺少可执行收款权资料' }
    ]),
    triggered_sheet: '5.1.1 时段（PO#3）；5.1.2 时点（PO#3）'
  })
]);
plan = RevenueWorkpaper.buildAppendixPlan(results);
const timingSheets = plan.filter((entry) => entry.appendix_type === 'recognition_timing');
assert.deepEqual(timingSheets.map((entry) => entry.display_name), [
  '5.1.1 时段（PO#1）',
  '5.1.2 时点（PO#2）'
]);
for (const poNo of [1, 2, 3]) {
  assert.ok(timingSheets.filter((entry) => Number(entry.po_no) === poNo).length <= 1);
}
assert.equal(timingSheets.some((entry) => Number(entry.po_no) === 3), false);
const uncertainTiming = results.find((entry) => entry.workpaper_sheet === '第5a步（PO#3）' && entry.question_no === '5.1');
assert.equal(uncertainTiming.suggested_answer, '');
assert.equal(uncertainTiming.confidence, '低');
assert.equal(uncertainTiming.review_status, '需人工复核');

// The question catalog always contains PO#1-PO#5 rows. Once the structured
// PO list is available, unused catalog rows must not create phantom PO sheets.
results = RevenueWorkpaper.normalizeResults([
  item('第2步', '2.1', '多项履约义务', {
    performance_obligations: json([
      { po_no: 'PO#1', name: '设备交付', source_question: '2.1' },
      { po_no: 'PO#2', name: '安装服务', source_question: '2.1' }
    ])
  }),
  item('第5a步（PO#1）', '5.1', '否'),
  item('第5a步（PO#2）', '5.1', '否'),
  item('第5a步（PO#3）', '5.1', '不适用（无此履约义务）'),
  item('第5a步（PO#4）', '5.1', '不适用（无此履约义务）'),
  item('第5a步（PO#5）', '5.1', '不适用（无此履约义务）')
]);
assert.deepEqual(RevenueWorkpaper.buildPerformanceObligations(results).map((po) => po.po_no), [1, 2]);
assert.equal(RevenueWorkpaper.buildAppendixPlan(results).some((entry) => Number(entry.po_no) > 2), false);

// Step 5 must consume the PO registry already confirmed by 2.1. A multi-PO
// review has five repair-service POs; every timing question must carry the
// concrete PO name and the shared transfer-pattern group instead of exposing a
// bare PO number that the model can reinterpret.
const asusRepairPos = [1, 2, 3, 4, 5].map((poNo) => ({
  po_no: 'PO#' + poNo,
  name: '维修服务-' + poNo,
  source_question: '2.1',
  components: '按对应区域/产品范围提供维修、WTP测试及返还服务',
  service_nature: '维修服务',
  transfer_pattern_group: 'TP-REPAIR',
  control_transfer_difference: '无',
  basis: '五项履约义务均执行相同维修、测试和返还流程'
}));
const asusPoRegistry = [
  item('第2步', '2.1', '多项履约义务（5项）', { performance_obligations: json(asusRepairPos) })
];
const timingQuestions = RevenueWorkpaper.buildPerformanceObligationTimingQuestions(asusPoRegistry);
assert.equal(timingQuestions.length, 5);
assert.deepEqual(timingQuestions.map((entry) => entry.po_no), [1, 2, 3, 4, 5]);
timingQuestions.forEach((entry, index) => {
  assert.match(entry.question, new RegExp('PO#' + (index + 1)));
  assert.match(entry.question, new RegExp('维修服务-' + (index + 1)));
  assert.match(entry.poContext, /履约义务清单已经由2\.1确认并锁定/);
  assert.match(entry.poContext, /控制权转移模式组：TP-REPAIR/);
});

// A later answer that says a locked PO does not exist is a hard conflict. It
// must not be converted into a point-in-time sheet.
results = RevenueWorkpaper.normalizeResults(asusPoRegistry.concat([
  item('第5a步（PO#2）', '5.1', '否', {
    answer_reason: '服务提供方仅提供单一维修服务，不存在PO#2，因此不适用。'
  })
]));
const lockedPoConflict = results.find((entry) => entry.workpaper_sheet === '第5a步（PO#2）' && entry.question_no === '5.1');
assert.equal(lockedPoConflict.po_context_conflict, true);
assert.equal(lockedPoConflict.suggested_answer, '不适用');
assert.match(lockedPoConflict.answer_reason, /已在2\.1确认存在.*认定为不存在/);
assert.equal(lockedPoConflict.review_status, '需人工复核');
assert.equal(RevenueWorkpaper.buildAppendixPlan(results).some((entry) => Number(entry.po_no) === 2 && entry.appendix_type === 'recognition_timing'), false);

// Once all five locked POs have valid timing decisions, point-in-time detail
// questions retain their PO context and are grouped under the same transfer
// pattern for consistency review.
const asusTimingItems = asusRepairPos.map((po) => item('第5a步（' + po.po_no + '）', '5.1', '否', {
  over_time_criteria: json([1, 2, 3].map((criterionNo) => ({
    po_no: po.po_no,
    criterion_no: String(criterionNo),
    result: '否',
    basis: '合同约定维修完成并通过WTP后结算'
  })))
}));
results = RevenueWorkpaper.normalizeResults(asusPoRegistry.concat(asusTimingItems));
const asusPointDetailQuestions = RevenueWorkpaper.buildTriggeredDetailQuestions(results);
assert.equal(asusPointDetailQuestions.filter((entry) => entry.questionNo === '5.1.2-1').length, 5);
assert.ok(asusPointDetailQuestions.every((entry) => entry.po_name && entry.transfer_pattern_group === 'TP-REPAIR'));
assert.ok(asusPointDetailQuestions.every((entry) => /已确认分析对象/.test(entry.question)));

// Conflicting answers for the same indicator in the same transfer-pattern
// group are detected and turned into a joint consistency-review batch.
results = RevenueWorkpaper.normalizeResults(asusPoRegistry.concat(asusTimingItems, [
  item('5.1.2 时点（PO#1）', '5.1.2-2', '否', { answer_reason: '维修服务不转移设备所有权。' }),
  item('5.1.2 时点（PO#2）', '5.1.2-2', '不适用', { answer_reason: '维修服务不涉及设备所有权。' })
]));
const consistencyConflicts = RevenueWorkpaper.findPoConsistencyConflicts(results);
assert.equal(consistencyConflicts.length, 1);
assert.equal(consistencyConflicts[0].group, 'TP-REPAIR');
assert.equal(results.filter((entry) => entry.question_no === '5.1.2-2' && entry.po_consistency_conflict).length, 2);
const consistencyReviewQuestions = RevenueWorkpaper.buildPoConsistencyReviewQuestions(results);
assert.equal(consistencyReviewQuestions.length, 2);
assert.ok(consistencyReviewQuestions.every((entry) => entry.consistency_review && /TP-REPAIR/.test(entry.poContext)));

// Legacy items-only responses (without the three structured JSON fields) still
// normalize as an array and retain the original single-sheet inferences.
const legacy = RevenueWorkpaper.normalizeResults([
  item('第2步', '2.1', '单项履约义务 - 单个商品或服务'),
  item('第3步', '3.1', '否（可变对价）—继续第3.2步'),
  item('第3步', '3.2', '是', { contract_basis: '存在销售返利。' }),
  item('第5a步（PO#1）', '5.1', '否')
]);
assert.ok(Array.isArray(legacy));
assert.equal(legacy.find((x) => x.question_no === '3.2').triggered_sheet, '3.2 可变对价');
assert.ok(planSheets(legacy).includes('5.1.2 时点（PO#1）'));

// A model-provided sheet name is never trusted when the controlled rules do not
// trigger it, including malformed structured JSON.
results = RevenueWorkpaper.normalizeResults([
  item('第3步', '3.2', '否', {
    triggered_sheet: '1.4 合同变更；任意工作表',
    appendix_subjects: '[not valid json]'
  })
]);
assert.equal(results[0].triggered_sheet, '无');
assert.deepEqual(RevenueWorkpaper.buildAppendixPlan(results), []);

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
assert.equal(results[0].suggested_answer, '是');
assert.equal(results[0].confidence, '低');
assert.equal(results[0].review_status, '需人工复核');
assert.match(results[0].missing_information, /原合同|主合同/);

// Structured PO and Step 5 data must expand into user-readable workpaper rows.
results = RevenueWorkpaper.normalizeResults([
  item('第2步', '2.1', '多项履约义务', {
    performance_obligations: json([
      {
        po_no: 'PO#1',
        name: '设备交付',
        source_question: '2.1',
        components: '设备及随机附件',
        capable_of_being_distinct: '是',
        distinct_in_contract_context: '是',
        conclusion: '单独履约义务',
        basis: '设备可单独交付并由客户独立使用',
        evidence_fact_ids: ['RF-device']
      }
    ])
  }),
  item('第5a步（PO#1）', '5.1', '否', {
    over_time_criteria: json([
      { po_no: 'PO#1', criterion_no: '1', result: '否', basis: '不属于持续服务', evidence_fact_ids: ['RF-device'] },
      { po_no: 'PO#1', criterion_no: '2', result: '否', basis: '交付前客户不控制设备', evidence_fact_ids: ['RF-control'] },
      { po_no: 'PO#1', criterion_no: '3', result: '否', basis: '无累计收款权条款', evidence_fact_ids: ['RF-payment'] }
    ])
  })
]);
const poDetail = results.find((x) => x.question_no === '2.1-PO#1');
assert.ok(poDetail);
assert.equal(poDetail.workpaper_sheet, '2.1 履约义务');
assert.match(poDetail.suggested_answer, /能够单独区分：是/);
assert.match(poDetail.suggested_answer, /在合同背景下可明确区分：是/);
assert.ok(poDetail.display_question_no);
assert.ok(poDetail.display_question_description);
assert.ok(poDetail.workpaper_section);
assert.doesNotMatch(poDetail.display_question_no, /PO#/i);
assert.deepEqual(results.filter((x) => /^5\.1-C[1-3]$/.test(x.question_no)).map((x) => x.suggested_answer), ['否', '否', '否']);

// All questions inside the triggered point-in-time sheet must be requested.
let detailQuestions = RevenueWorkpaper.buildTriggeredDetailQuestions(results);
assert.equal(detailQuestions.length, 7);
assert.ok(detailQuestions.some((x) => x.sheet === '5.1.2 时点（PO#1）' && x.questionNo === '5.1.2-C'));

// Over-time conclusions start with the first two workbook sections. Later
// sections are requested in follow-up rounds according to those answers.
results = RevenueWorkpaper.normalizeResults([
  item('第2步', '2.1', '单项履约义务 - 单个商品或服务', {
    performance_obligations: json([{ po_no: 'PO#1', name: '持续运维服务', source_question: '2.1' }])
  }),
  item('第5a步（PO#1）', '5.1', '是', {
    over_time_criteria: json([
      { po_no: 'PO#1', criterion_no: '1', result: '是', basis: '客户同步取得服务利益' },
      { po_no: 'PO#1', criterion_no: '2', result: '否', basis: '未形成客户控制资产' },
      { po_no: 'PO#1', criterion_no: '3', result: '否', basis: '不适用' }
    ])
  })
]);
detailQuestions = RevenueWorkpaper.buildTriggeredDetailQuestions(results);
assert.deepEqual(detailQuestions.map((x) => x.questionNo), ['5.1.1-A1', '5.1.1-A2']);
assert.ok(detailQuestions.every((x) => x.sheet === '5.1.1 时段（PO#1）'));

// Evidence facts retain their exact source-file/page pairing.
results = RevenueWorkpaper.applySharedFacts([
  item('第4步', '4.1', '否', { evidence_fact_ids: json(['RF-main', 'RF-order']) })
], [
  { fact_id: 'RF-main', fact_type: '交付条件', fact_summary: '完成交付', source_id: 'main', source_document: '主合同.pdf', pages: '【第3页】' },
  { fact_id: 'RF-order', fact_type: '价格与数量', fact_summary: '订单数量', source_id: 'order', source_document: '订单.pdf', pages: '【第7页】' }
]);
assert.equal(results[0].source_documents, '主合同.pdf；订单.pdf');
assert.equal(results[0].pages, '【第3页】、【第7页】');
assert.deepEqual(JSON.parse(results[0].evidence_refs).map((ref) => [ref.source_document, ref.pages]), [
  ['主合同.pdf', '【第3页】'],
  ['订单.pdf', '【第7页】']
]);

// Every other triggered revenue appendix also expands to its row-level
// assessment questions, including separate PVA instances by subject.
results = RevenueWorkpaper.normalizeResults([
  item('第1步', '1.4', '是'),
  item('第2步', '2.2', '是'),
  item('第2步', '2.2.1', '是', {
    appendix_subjects: json([
      { subject_id: 'PVA-01', template_sheet: '2.2.1 PVA', instance_no: 1, subject: '设备交付', source_question: '2.2.1' },
      { subject_id: 'PVA-02', template_sheet: '2.2.1 PVA', instance_no: 2, subject: '安装服务', source_question: '2.2.1' }
    ])
  }),
  item('第2步', '2.3', '是'),
  item('第3步', '3.1', '否（可变对价）—继续第3.2步'),
  item('第3步', '3.2', '是', {
    appendix_subjects: json([{ subject_id: 'VC-01', template_sheet: '3.2 可变对价', instance_no: 1, subject: '销售返利', source_question: '3.2' }])
  }),
  item('第3步', '3.5', '是', {
    appendix_subjects: json([{ subject_id: 'PC-01', template_sheet: '3.5 客户对价', instance_no: 1, subject: '货位费', source_question: '3.5' }])
  })
]);
detailQuestions = RevenueWorkpaper.buildTriggeredDetailQuestions(results);
assert.ok(detailQuestions.filter((x) => /^1\.4-M/.test(x.questionNo)).length >= 5);
assert.equal(detailQuestions.filter((x) => /^2\.2\.1-PVA/.test(x.questionNo)).length, 20);
assert.equal(new Set(detailQuestions.filter((x) => /^2\.2\.1-PVA/.test(x.questionNo)).map((x) => x.sheet)).size, 2);
assert.equal(detailQuestions.some((x) => x.questionNo === '2.3-W3'), false);
assert.equal(detailQuestions.some((x) => x.questionNo === '2.3-W11'), false);
assert.equal(detailQuestions.some((x) => x.questionNo === '2.3-W12'), false);
assert.equal(detailQuestions.some((x) => x.questionNo === '3.2-VC13'), true);
assert.equal(detailQuestions.some((x) => /^3\.5-PC[4-6]$/.test(x.questionNo)), false);

// Triggered appendices keep their internal IDs for matching only. Every row
// exposed to the reviewer must carry the workbook's own section/number/text.
const appendixInternalId = /^(?:1\.4-M\d+|2\.2\.1-PVA\d+|2\.3-W\d+|3\.2-VC\d+|3\.5-PC\d+|5\.1-C\d+|5\.1\.1-[AOI]\w*|5\.1\.2-(?:\d+|C))$/;
const mappedAppendixQuestions = RevenueWorkpaper.detailQuestions.filter((entry) => appendixInternalId.test(entry.questionNo));
assert.ok(mappedAppendixQuestions.length > 0);
mappedAppendixQuestions.forEach((entry) => {
  assert.ok(String(entry.displayQuestionNo || '').trim(), `${entry.sheet}/${entry.questionNo} 缺少底稿显示编号`);
  assert.ok(String(entry.displayQuestion || '').trim(), `${entry.sheet}/${entry.questionNo} 缺少底稿原始问题`);
  assert.ok(String(entry.displaySection || '').trim(), `${entry.sheet}/${entry.questionNo} 缺少底稿章节`);
  assert.doesNotMatch(entry.displayQuestionNo, /(?:-M\d+|-PVA\d+|-W\d+|-VC\d+|-PC\d+|-[AOI]\d+)/);
});

// Spot-check the warranty sheet against the workbook's actual hierarchy. W3
// is only the Part 3 heading and therefore must not be emitted as an answer row.
const warrantyCatalog = RevenueWorkpaper.detailQuestions.filter((entry) => entry.sheet === '2.3 质保');
assert.equal(warrantyCatalog.some((entry) => entry.questionNo === '2.3-W3'), false);
const warrantyById = Object.fromEntries(warrantyCatalog.map((entry) => [entry.questionNo, entry]));
assert.equal(warrantyById['2.3-W1'].displayQuestionNo, '第1部分');
assert.equal(warrantyById['2.3-W1'].displayQuestion, '简要描述与客户的质保安排');
assert.equal(warrantyById['2.3-W2'].displayQuestionNo, '第2部分');
assert.equal(warrantyById['2.3-W4'].displayQuestionNo, '第3部分(a)');
assert.equal(warrantyById['2.3-W4'].displayQuestion, '法律是否要求质保？');
assert.equal(warrantyById['2.3-W5'].displayQuestionNo, '第3部分(b)');
assert.equal(warrantyById['2.3-W6'].displayQuestionNo, '第3部分(c)');
assert.equal(warrantyById['2.3-W7'].displayQuestionNo, '第3部分(d)');
assert.equal(warrantyById['2.3-W8'].displayQuestionNo, '第3部分(e)');
assert.equal(warrantyById['2.3-W9'].displayQuestionNo, '第3部分结论');
assert.equal(warrantyById['2.3-W10'].displayQuestionNo, '第4部分');
assert.equal(warrantyById['2.3-W11'].displayQuestionNo, '第5部分');
assert.equal(warrantyById['2.3-W12'].displayQuestionNo, '第5部分—分配基础');

function assertAppendixCells(sheet, expected) {
  const catalog = RevenueWorkpaper.detailQuestions.filter((entry) => entry.sheet === sheet);
  const byId = Object.fromEntries(catalog.map((entry) => [entry.questionNo, entry]));
  Object.entries(expected).forEach(([questionNo, cells]) => {
    assert.ok(byId[questionNo], `${sheet}/${questionNo} 不存在`);
    if (cells.answer) assert.equal(byId[questionNo].answerCell, cells.answer, `${questionNo} 回答单元格错误`);
    if (cells.reason) assert.equal(byId[questionNo].reasonCell, cells.reason, `${questionNo} 理由单元格错误`);
    if (cells.evidence) assert.equal(byId[questionNo].evidenceCell, cells.evidence, `${questionNo} 摘录单元格错误`);
  });
}

assertAppendixCells('1.4 合同变更', {
  '1.4-M1': { answer: 'B18' }, '1.4-M2': { answer: 'B22' },
  '1.4-M3': { answer: 'B26' }, '1.4-M4': { answer: 'B30' },
  '1.4-M5': { answer: 'B33' }, '1.4-M6': { answer: 'B37' },
  '1.4-M7': { answer: 'B39' }, '1.4-M8': { answer: 'B42' }
});
assertAppendixCells('2.2.1 PVA', {
  '2.2.1-PVA1': { answer: 'B16' }, '2.2.1-PVA2': { answer: 'B20' },
  '2.2.1-PVA3': { answer: 'B23' }, '2.2.1-PVA4': { answer: 'B27' },
  '2.2.1-PVA5': { answer: 'B33' }, '2.2.1-PVA6': { answer: 'B41' },
  '2.2.1-PVA7': { answer: 'B45' }, '2.2.1-PVA8': { answer: 'B49' },
  '2.2.1-PVA9': { answer: 'B52' }, '2.2.1-PVA10': { answer: 'B55' }
});
assertAppendixCells('2.3 质保', {
  '2.3-W1': { answer: 'B15' }, '2.3-W2': { answer: 'B18' },
  '2.3-W4': { answer: 'B26' }, '2.3-W5': { answer: 'B30' },
  '2.3-W6': { answer: 'B34' }, '2.3-W7': { answer: 'B38' },
  '2.3-W8': { answer: 'B41' }, '2.3-W9': { answer: 'B44', reason: 'B46', evidence: 'C46' },
  '2.3-W10': { answer: 'B49' }, '2.3-W11': { answer: 'B52' },
  '2.3-W12': { answer: 'B55' }
});
assertAppendixCells('3.2 可变对价', {
  '3.2-VC1': { answer: 'B18' }, '3.2-VC2': { answer: 'B22' },
  '3.2-VC3': { answer: 'B26', reason: 'B28', evidence: 'C28' },
  '3.2-VC4': { answer: 'B30' },
  '3.2-VC5': { answer: 'C40', reason: 'B41', evidence: 'C41' },
  '3.2-VC6': { answer: 'C43', reason: 'B44', evidence: 'C44' },
  '3.2-VC7': { answer: 'C46', reason: 'B47', evidence: 'C47' },
  '3.2-VC8': { answer: 'C49', reason: 'B50', evidence: 'C50' },
  '3.2-VC9': { answer: 'C52', reason: 'B53', evidence: 'C53' },
  '3.2-VC10': { answer: 'C55', reason: 'B56', evidence: 'C56' },
  '3.2-VC11': { answer: 'C60', reason: 'B60' },
  '3.2-VC12': { answer: 'B62', evidence: 'C62' },
  '3.2-VC13': { answer: 'B64', evidence: 'C64' },
  '3.2-VC14': { answer: 'B67', evidence: 'C67' }
});
assertAppendixCells('3.5 客户对价', {
  '3.5-PC1': { answer: 'B17' }, '3.5-PC2': { answer: 'B21' },
  '3.5-PC3': { answer: 'B23' }, '3.5-PC4': { answer: 'B26' },
  '3.5-PC5': { answer: 'B28' }, '3.5-PC6': { answer: 'B31' }
});
assertAppendixCells('5.1.1 时段（PO#1）', {
  '5.1.1-A1': { answer: 'B14', evidence: 'C14' },
  '5.1.1-A2': { answer: 'B17', reason: 'B19', evidence: 'C19' },
  '5.1.1-A3': { answer: 'B22', reason: 'B24', evidence: 'C24' },
  '5.1.1-A4': { answer: 'B28', reason: 'B30', evidence: 'C30' },
  '5.1.1-O1': { answer: 'C35', reason: 'B37', evidence: 'C37' },
  '5.1.1-O2': { answer: 'B40', reason: 'B42', evidence: 'C42' },
  '5.1.1-I1': { answer: 'B47', reason: 'B49', evidence: 'C49' },
  '5.1.1-I2': { answer: 'B52', reason: 'B54', evidence: 'C54' },
  '5.1.1-I3': { answer: 'B56' },
  '5.1.1-I3a': { answer: 'C61', reason: 'B62', evidence: 'C62' },
  '5.1.1-I3b': { answer: 'C64', reason: 'B65', evidence: 'C65' },
  '5.1.1-I3c': { answer: 'C67', reason: 'B68', evidence: 'C68' },
  '5.1.1-I3d': { answer: 'C70', reason: 'B71', evidence: 'C71' },
  '5.1.1-I4': { answer: 'B73', reason: 'B75', evidence: 'C75' },
  '5.1.1-I5': { answer: 'B77', reason: 'B79', evidence: 'C79' }
});
assertAppendixCells('5.1.2 时点（PO#1）', {
  '5.1.2-1': { answer: 'D13', reason: 'E13', evidence: 'F13' },
  '5.1.2-2': { answer: 'D16', reason: 'E16', evidence: 'F16' },
  '5.1.2-3': { answer: 'D18', reason: 'E18', evidence: 'F18' },
  '5.1.2-4': { answer: 'D21', reason: 'E21', evidence: 'F21' },
  '5.1.2-5': { answer: 'D24', reason: 'E24', evidence: 'F24' },
  '5.1.2-7': { answer: 'D27', reason: 'E27', evidence: 'F27' },
  '5.1.2-C': { answer: 'B29', evidence: 'F29' }
});

// The normalized result and the exported checklist use workbook-facing fields,
// while retaining the internal question number for matching and control flow.
const mappedSample = RevenueWorkpaper.normalizeResults([
  item('2.3 质保', '2.3-W4', '否', { question_description: '模型改写过的问题' }),
  item('3.2 可变对价-销售返利', '3.2-VC5', '是', { question_description: '模型改写过的问题' }),
  item('3.5 应付客户对价-货位费', '3.5-PC2', '否', { question_description: '模型改写过的问题' }),
  item('5.1.2 时点（PO#1）', '5.1.2-1', '是', { question_description: '模型改写过的问题' })
]);
mappedSample.forEach((entry) => {
  assert.ok(entry.display_question_no);
  assert.ok(entry.display_question_description);
  assert.ok(entry.workpaper_section);
});
const mappedRows = RevenueWorkpaper.buildChecklistRows({ file: '映射测试合同.pdf' }, mappedSample);
const mappedDisplayKeys = new Set(mappedSample.map((entry) => [
  entry.display_question_no,
  entry.display_question_description,
  entry.workpaper_section
].join('|')));
mappedRows.forEach((row) => {
  assert.ok(mappedDisplayKeys.has([row['问题编号'], row['问题描述'], row['底稿章节']].join('|')));
  assert.doesNotMatch(row['问题编号'], /(?:-M\d+|-PVA\d+|-W\d+|-VC\d+|-PC\d+|-[AOI]\d+)/);
});

// Warranty follows the workbook's conditional path. The allocation questions
// must never be generated merely because the warranty appendix was triggered.
function warrantyWanted(extraItems) {
  return RevenueWorkpaper.buildTriggeredDetailQuestions([
    item('第2步', '2.3', '是', {
      appendix_subjects: json([{ subject_id: 'WAR-01', template_sheet: '2.3 质保', instance_no: 1, subject: '维修质保', source_question: '2.3' }])
    }),
    ...(extraItems || [])
  ]).map((entry) => entry.questionNo);
}
let warrantyWantedIds = warrantyWanted();
assert.equal(warrantyWantedIds.includes('2.3-W3'), false);
assert.equal(warrantyWantedIds.includes('2.3-W11'), false);
assert.equal(warrantyWantedIds.includes('2.3-W12'), false);
warrantyWantedIds = warrantyWanted([
  item('2.3 质保-维修质保', '2.3-W10', '否', { subject_id: 'WAR-01', appendix_instance_no: 1 })
]);
assert.equal(warrantyWantedIds.includes('2.3-W11'), false);
assert.equal(warrantyWantedIds.includes('2.3-W12'), false);
warrantyWantedIds = warrantyWanted([
  item('2.3 质保-维修质保', '2.3-W10', '是', { subject_id: 'WAR-01', appendix_instance_no: 1 })
]);
assert.equal(warrantyWantedIds.includes('2.3-W11'), true);
assert.equal(warrantyWantedIds.includes('2.3-W12'), false);
warrantyWantedIds = warrantyWanted([
  item('2.3 质保-维修质保', '2.3-W10', '是', { subject_id: 'WAR-01', appendix_instance_no: 1 }),
  item('2.3 质保-维修质保', '2.3-W11', '是', { subject_id: 'WAR-01', appendix_instance_no: 1 })
]);
assert.equal(warrantyWantedIds.includes('2.3-W12'), true);

// Conditional answers from one appendix subject must not unlock another
// subject's branch. This prevents two warranty/variable-consideration matters
// from contaminating each other in the same review.
const isolatedWarranty = RevenueWorkpaper.normalizeResults([
  item('2.3 质保-维修后12个月保固', '2.3-W10', '否', { subject_id: 'WAR-01', appendix_instance_no: 1 }),
  item('2.3 质保-额外12个月保修', '2.3-W10', '是', { subject_id: 'WAR-02', appendix_instance_no: 2 }),
  item('2.3 质保-维修后12个月保固', '2.3-W11', '不适用', { subject_id: 'WAR-01', appendix_instance_no: 1 }),
  item('2.3 质保-额外12个月保修', '2.3-W11', '是', { subject_id: 'WAR-02', appendix_instance_no: 2 }),
  item('2.3 质保-维修后12个月保固', '2.3-W12', '不适用', { subject_id: 'WAR-01', appendix_instance_no: 1 }),
  item('2.3 质保-额外12个月保修', '2.3-W12', '按单独售价分配', { subject_id: 'WAR-02', appendix_instance_no: 2 })
]);
const isolatedBySubject = (subjectId, no) => isolatedWarranty.find((entry) => entry.subject_id === subjectId && entry.question_no === no);
assert.equal(isolatedBySubject('WAR-01', '2.3-W11').conditional_hidden, true);
assert.equal(isolatedBySubject('WAR-01', '2.3-W12').conditional_hidden, true);
assert.equal(isolatedBySubject('WAR-02', '2.3-W11').conditional_hidden, false);
assert.equal(isolatedBySubject('WAR-02', '2.3-W12').conditional_hidden, false);

// Equivalent branch rules apply to the other pop-up appendices: downstream
// rows are only requested after the controlling conclusion requires them.
function wantedFor(main, details) {
  return RevenueWorkpaper.buildTriggeredDetailQuestions([main, ...(details || [])]).map((entry) => entry.questionNo);
}
let wantedIds = wantedFor(item('第1步', '1.4', '是'));
assert.equal(wantedIds.includes('1.4-M6'), false);
assert.equal(wantedIds.includes('1.4-M7'), false);
assert.equal(wantedIds.includes('1.4-M8'), false);
wantedIds = wantedFor(item('第1步', '1.4', '是'), [
  item('1.4 合同变更', '1.4-M5', '否，不作为单独合同')
]);
assert.equal(wantedIds.includes('1.4-M6'), true);
assert.equal(wantedIds.includes('1.4-M7'), true);
assert.equal(wantedIds.includes('1.4-M8'), true);
wantedIds = wantedFor(item('第1步', '1.4', '是'), [
  item('1.4 合同变更', '1.4-M5', '是，作为单独合同')
]);
assert.equal(wantedIds.includes('1.4-M6'), false);
assert.equal(wantedIds.includes('1.4-M7'), false);
assert.equal(wantedIds.includes('1.4-M8'), false);

function variableWanted(details) {
  return RevenueWorkpaper.buildTriggeredDetailQuestions([
    item('第3步', '3.1', '否（存在可变对价）'),
    item('第3步', '3.2', '是', {
      appendix_subjects: json([{ subject_id: 'VC-01', template_sheet: '3.2 可变对价', instance_no: 1, subject: '销售返利', source_question: '3.2' }])
    }),
    ...(details || [])
  ]).map((entry) => entry.questionNo);
}
wantedIds = variableWanted();
assert.equal(wantedIds.includes('3.2-VC13'), true);
wantedIds = variableWanted([
  item('3.2 可变对价-销售返利', '3.2-VC12', '是', { subject_id: 'VC-01', appendix_instance_no: 1 })
]);
assert.equal(wantedIds.includes('3.2-VC13'), true);

wantedIds = wantedFor(item('第3步', '3.5', '是', {
  appendix_subjects: json([{ subject_id: 'PC-01', template_sheet: '3.5 客户对价', instance_no: 1, subject: '货位费', source_question: '3.5' }])
}), [item('3.5 应付客户对价-货位费', '3.5-PC3', '抵减交易价格', { subject_id: 'PC-01', appendix_instance_no: 1 })]);
assert.equal(wantedIds.includes('3.5-PC4'), false);
assert.equal(wantedIds.includes('3.5-PC5'), false);
assert.equal(wantedIds.includes('3.5-PC6'), false);

wantedIds = wantedFor(item('第3步', '3.5', '是', {
  appendix_subjects: json([{ subject_id: 'PC-01', template_sheet: '3.5 客户对价', instance_no: 1, subject: '货位费', source_question: '3.5' }])
}), [item('3.5 应付客户对价-货位费', '3.5-PC3', '是，取得可明确区分的商品或服务', { subject_id: 'PC-01', appendix_instance_no: 1 })]);
assert.equal(wantedIds.includes('3.5-PC4'), true);
assert.equal(wantedIds.includes('3.5-PC5'), true);
assert.equal(wantedIds.includes('3.5-PC6'), false);

wantedIds = wantedFor(item('第3步', '3.5', '是', {
  appendix_subjects: json([{ subject_id: 'PC-01', template_sheet: '3.5 客户对价', instance_no: 1, subject: '货位费', source_question: '3.5' }])
}), [
  item('3.5 应付客户对价-货位费', '3.5-PC3', '是，取得可明确区分的商品或服务', { subject_id: 'PC-01', appendix_instance_no: 1 }),
  item('3.5 应付客户对价-货位费', '3.5-PC5', '是，公允价值能够合理估计', { subject_id: 'PC-01', appendix_instance_no: 1 })
]);
assert.equal(wantedIds.includes('3.5-PC6'), true);

function overTimeWanted(extraItems) {
  return RevenueWorkpaper.buildTriggeredDetailQuestions([
    item('第2步', '2.1', '单项履约义务 - 单个商品或服务', {
      performance_obligations: json([{ po_no: 'PO#1', name: '持续服务', source_question: '2.1' }])
    }),
    item('第5a步（PO#1）', '5.1', '是', {
      over_time_criteria: json([
        { po_no: 'PO#1', criterion_no: '1', result: '是', basis: '客户同步取得利益' },
        { po_no: 'PO#1', criterion_no: '2', result: '否', basis: '不适用' },
        { po_no: 'PO#1', criterion_no: '3', result: '否', basis: '不适用' }
      ])
    }),
    ...(extraItems || [])
  ]).map((entry) => entry.questionNo);
}

let overTimeIds = overTimeWanted([
  item('5.1.1 时段（PO#1）', '5.1.1-A2', '否')
]);
assert.equal(overTimeIds.includes('5.1.1-A3'), true);
assert.equal(overTimeIds.includes('5.1.1-A4'), false);
overTimeIds = overTimeWanted([
  item('5.1.1 时段（PO#1）', '5.1.1-A2', '是')
]);
assert.equal(overTimeIds.includes('5.1.1-A3'), false);
assert.equal(overTimeIds.includes('5.1.1-A4'), true);

overTimeIds = overTimeWanted([
  item('5.1.1 时段（PO#1）', '5.1.1-A2', '是'),
  item('5.1.1 时段（PO#1）', '5.1.1-A4', '产出法')
]);
assert.equal(overTimeIds.includes('5.1.1-O1'), true);
assert.equal(overTimeIds.includes('5.1.1-I1'), false);
overTimeIds = overTimeWanted([
  item('5.1.1 时段（PO#1）', '5.1.1-A2', '是'),
  item('5.1.1 时段（PO#1）', '5.1.1-A4', '产出法'),
  item('5.1.1 时段（PO#1）', '5.1.1-O1', '否')
]);
assert.equal(overTimeIds.includes('5.1.1-O2'), true);

overTimeIds = overTimeWanted([
  item('5.1.1 时段（PO#1）', '5.1.1-A2', '是'),
  item('5.1.1 时段（PO#1）', '5.1.1-A4', '投入法'),
  item('5.1.1 时段（PO#1）', '5.1.1-I3', '否')
]);
assert.equal(overTimeIds.includes('5.1.1-I1'), true);
assert.equal(overTimeIds.includes('5.1.1-I2'), true);
assert.equal(overTimeIds.includes('5.1.1-I3'), false); // already answered, so it is not requested again
assert.equal(overTimeIds.includes('5.1.1-I3a'), false);
assert.equal(overTimeIds.includes('5.1.1-O1'), false);
overTimeIds = overTimeWanted([
  item('5.1.1 时段（PO#1）', '5.1.1-A2', '是'),
  item('5.1.1 时段（PO#1）', '5.1.1-A4', '投入法'),
  item('5.1.1 时段（PO#1）', '5.1.1-I3', '是')
]);
assert.equal(overTimeIds.includes('5.1.1-I3a'), true);
assert.equal(overTimeIds.includes('5.1.1-I3b'), true);
assert.equal(overTimeIds.includes('5.1.1-I3c'), true);
assert.equal(overTimeIds.includes('5.1.1-I3d'), true);

console.log('Revenue workpaper rule checks passed.');
