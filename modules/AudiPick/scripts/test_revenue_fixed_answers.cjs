const assert = require('node:assert/strict');

global.window = global;
require('../rules/revenue_workpaper.js');
global.RULE_PROMPTS = {};
require('../rules/prompts/revenue_workpaper.js');

function item(sheet, no, answer, extra) {
  return Object.assign({
    workpaper_sheet: sheet,
    question_no: no,
    question_description: '',
    suggested_answer: answer,
    contract_basis: '',
    sop_basis: '',
    answer_reason: '现有资料支持有倾向性的初步结论，但仍需项目组复核。',
    contract_excerpt: '合同包含相应约定。',
    source_documents: '主合同.pdf',
    supporting_evidence: '',
    missing_information: '无',
    triggered_sheet: '无',
    appendix_status: '未触发',
    fill_readiness: '需人工判断',
    pages: '【第1页】',
    confidence: '低',
    review_status: '需人工复核'
  }, extra || {});
}

const forbiddenAnswerState = /需要人工判断|需人工判断|需进一步判断|待判断|无法判断|不能判断|需人工复核/;

// The prompt must keep uncertainty in confidence/review/reason fields instead
// of inventing a value that cannot be selected in the workbook cell.
assert.match(RULE_PROMPTS.revenue_workpaper, /suggested_answer/);
assert.match(RULE_PROMPTS.revenue_workpaper, /需要人工判断|需人工判断/);
assert.match(RULE_PROMPTS.revenue_workpaper, /置信度|confidence/);
assert.match(RULE_PROMPTS.revenue_workpaper, /复核状态|review_status/);

function assertCanonical(input, allowedAnswers) {
  const normalized = RevenueWorkpaper.normalizeResults([input]);
  assert.equal(normalized.length, 1);
  const result = normalized[0];
  assert.ok(allowedAnswers.includes(result.suggested_answer),
    `${input.question_no} 不是底稿固定答案：${result.suggested_answer}`);
  assert.doesNotMatch(result.suggested_answer, forbiddenAnswerState);
  assert.equal(result.confidence, '低');
  assert.equal(result.review_status, '需人工复核');
  assert.equal(result.fill_readiness, '建议填入，需复核');
  assert.match(result.answer_reason, /初步结论|复核/);
  return result;
}

// Main-sheet dropdowns with verbose workbook options must be normalized to the
// exact selectable value, not a shortened or annotated AI answer.
assertCanonical(item('第2步', '2.1', '多项履约义务（初步判断）'), [
  '单项履约义务——单项商品或服务',
  '单项履约义务——多项商品和/或服务——请参见“2.1 履约义务”标签页，获取详细信息',
  '多项履约义务——请参见“2.1 履约义务”标签页，获取详细信息'
]);
assertCanonical(item('第2步', '2.3', '是（初步判断，需人工复核）'), [
  '是——请参见“2.3 质保”标签页，获取详细信息',
  '否'
]);
assertCanonical(item('第3步', '3.1', '是（但仍需项目组判断）'), [
  '是（固定价格）',
  '否（可变对价）—继续第3.2步',
  '否（固定价格和可变对价均存在）—继续第3.2步'
]);
assertCanonical(item('第3步', '3.2', '是，需要人工判断'), [
  '是—请参见“3.2 可变对价”工作表，了解更多详情',
  '是-实体不估计可变对价，因为金额在报告期末已知',
  '否'
]);
assertCanonical(item('第3步', '3.5', '是（结论需复核）'), [
  '是—请参见“3.5 应付客户对价”工作表，了解更多详情',
  '否'
]);

// Plain yes/no dropdowns use only 是 or 否. Qualifiers belong in reason,
// confidence and review_status, including triggered appendix rows.
assertCanonical(item('第3步', '3.3', '否（需要人工判断）'), ['是', '否']);
assertCanonical(item('3.2 可变对价-销售返利', '3.2-VC5', '是（低置信度）', {
  subject_id: 'VC-01',
  appendix_instance_no: 1
}), ['是', '否']);
assertCanonical(item('5.1.2 时点（PO#1）', '5.1.2-1', '是（需进一步判断）'), ['是', '否']);

// Even when the model returns only an uncertainty state, decisive contract
// evidence must produce a selectable preliminary answer and keep the caveat in
// the review metadata.
assertCanonical(item('第2步', '2.3', '需要人工判断', {
  contract_basis: '客户可以选择单独购买额外十二个月延长质保服务。',
  contract_excerpt: '客户可另行购买延长质保服务。',
  answer_reason: '合同明确存在可单独购买的额外质保服务，初步判断应触发质保附表，最终结论需项目组复核。'
}), [
  '是——请参见“2.3 质保”标签页，获取详细信息',
  '否'
]);

function assertUnresolved(input) {
  const result = RevenueWorkpaper.normalizeResults([input])[0];
  assert.equal(result.suggested_answer, '');
  assert.equal(result.confidence, '低');
  assert.equal(result.review_status, '需人工复核');
  assert.equal(result.fill_readiness, '资料不足');
  assert.doesNotMatch(result.suggested_answer, forbiddenAnswerState);
}

// With no reliable direction, normalization must not silently default to 否.
// The answer cell remains blank and the uncertainty is made explicit beside it.
assertUnresolved(item('第3步', '3.3', '需要人工判断', {
  contract_basis: '',
  contract_excerpt: '',
  answer_reason: '现有资料不足以支持“是”或“否”中的任一结论。',
  missing_information: '付款时间表与履约时间表'
}));

// Every actual yes/no data-validation cell in the standard workbook preserves
// its selectable value exactly. Free-text conclusions are intentionally not in
// this list and must not be coerced by a generic binary rule.
const yesNoValidationQuestions = [
  ['第1步', '1.1(a)'], ['第1步', '1.1.1'], ['第1步', '1.1.1(a)'],
  ['第1步', '1.2'], ['第1步', '1.3'],
  ['第2步', '2.2'], ['第2步', '2.4'],
  ['2.2.1 PVA-测试对象', '2.2.1-PVA10'],
  ['第3步', '3.3'], ['第3步', '3.4'], ['第3步', '3.6'],
  ['第4步', '4.1'], ['第4步', '4.2'], ['第4步', '4.3'],
  ['第5a步（PO#1）', '5.1-C1'], ['第5a步（PO#1）', '5.1-C2'], ['第5a步（PO#1）', '5.1-C3'],
  ['3.2 可变对价-测试对象', '3.2-VC5'], ['3.2 可变对价-测试对象', '3.2-VC6'],
  ['3.2 可变对价-测试对象', '3.2-VC7'], ['3.2 可变对价-测试对象', '3.2-VC8'],
  ['3.2 可变对价-测试对象', '3.2-VC9'], ['3.2 可变对价-测试对象', '3.2-VC10'],
  ['3.2 可变对价-测试对象', '3.2-VC14'],
  ['5.1.1 时段（PO#1）', '5.1.1-I3a'], ['5.1.1 时段（PO#1）', '5.1.1-I3b'],
  ['5.1.1 时段（PO#1）', '5.1.1-I3c'], ['5.1.1 时段（PO#1）', '5.1.1-I3d'],
  ['5.1.2 时点（PO#1）', '5.1.2-1'], ['5.1.2 时点（PO#1）', '5.1.2-2'],
  ['5.1.2 时点（PO#1）', '5.1.2-3'], ['5.1.2 时点（PO#1）', '5.1.2-4'],
  ['5.1.2 时点（PO#1）', '5.1.2-5'], ['5.1.2 时点（PO#1）', '5.1.2-7'],
  ['第5b步', '5.2'], ['第5b步', '5.2.1'], ['第5b步', '5.2.2'],
  ['第5b步', '5.3'], ['第5b步', '5.4'], ['第5b步', '5.5'],
  ['其他', 'C.1'], ['其他', 'C.2'], ['其他', 'C.4']
];
yesNoValidationQuestions.forEach(([sheet, no]) => {
  assert.deepEqual(RevenueWorkpaper.answerOptions[no], ['是', '否'], `${no} 固定答案目录错误`);
  ['是', '否'].forEach((answer) => {
    const result = RevenueWorkpaper.normalizeResults([item(sheet, no, answer, {
      answer_reason: answer === '是' ? '合同证据支持肯定选项。' : '合同证据支持否定选项。'
    })])[0];
    assert.equal(result.suggested_answer, answer, `${sheet}/${no} 未保留底稿固定值 ${answer}`);
  });
});

// Long dropdown options round-trip verbatim. This guards against treating every
// field as a generic binary cell and destroying the workbook's prescribed text.
const longDropdowns = [
  ['第1步', '1.3.1', ['是——将合同合并，在后续的五步分析中将其一并考虑', '否——分别评估各合同']],
  ['第1步', '1.4', ['是——请参见“1.4 合同变更”标签页，获取详细信息', '否']],
  ['第2步', '2.1', [
    '单项履约义务——单项商品或服务',
    '单项履约义务——多项商品和/或服务——请参见“2.1 履约义务”标签页，获取详细信息',
    '多项履约义务——请参见“2.1 履约义务”标签页，获取详细信息'
  ]],
  ['第2步', '2.1.1', ['是-请参阅“第4步”工作表了解更多详细信息', '否']],
  ['第2步', '2.2.1', ['是——请参见“2.2.1 PVA”标签页，获取详细信息', '否']],
  ['第2步', '2.3', ['是——请参见“2.3 质保”标签页，获取详细信息', '否']],
  ['第3步', '3.1', ['是（固定价格）', '否（可变对价）—继续第3.2步', '否（固定价格和可变对价均存在）—继续第3.2步']],
  ['第3步', '3.2', ['是—请参见“3.2 可变对价”工作表，了解更多详情', '是-实体不估计可变对价，因为金额在报告期末已知', '否']],
  ['第3步', '3.5', ['是—请参见“3.5 应付客户对价”工作表，了解更多详情', '否']]
];
longDropdowns.push(
  ['1.4 合同变更', '1.4-M5', [
    '基于上述情况，合同变更涉及“可明确区分”且具有“单独售价”的“新增商品或服务”的提供。合同作为单独合同进行会计处理（结果1）。',
    '基于上述情况，合同变更不涉及“可明确区分”且具有“单独售价”的“新增商品或服务”的提供。请转到第3部分进行进一步评估。'
  ]],
  ['1.4 合同变更', '1.4-M8', [
    '基于上述情况，剩余商品或服务与已经提供的商品或服务可明确区分，且合同变更根据前瞻法进行会计处理（即，终止现有合同并创建新合同）（结果2）。',
    '基于上述情况，剩余商品或服务与已经提供的商品或服务没有区别，且合同变更作为现有合同的一部分进行会计处理，且构成单项履约义务的一部分，且收入按累计增加法进行调整（结果3）。',
    '基于上述情况，部分剩余商品或服务与已经提供的商品或服务可明确区分，而部分剩余商品或服务与已经提供的商品或服务不可明确区分。因此，(i)不对可与已修订商品或服务明确区分的完全履约义务进行调整且(ii)对与合同已修订部分不可明确区分的履约义务进行累计增加调整（结果4）。'
  ]],
  ['2.2.1 PVA-测试对象', '2.2.1-PVA9', [
    '基于上述评估，主体是安排中的主要责任人。',
    '基于上述评估，主体是安排中的代理人。'
  ]],
  ['2.3 质保', '2.3-W2', [
    '是—客户可以选择单独购买质保。这是服务型质保，作为单独的履约义务进行会计处理。',
    '否—客户不可以选择单独购买质保。请转到第3部分进行进一步评估。',
    '合同包括质保，其中一部分是客户可选择购买的。就顾客可以选择单独购买的质保而言，它属于服务型质保。关于不能单独购买的质保，请转到第3部分进行进一步评估.'
  ]],
  ['2.3 质保', '2.3-W9', [
    '是—质保(或部分质保)除保证产品符合商定的规格外，还向客户提供服务。这是服务型质保，作为单独的履约义务进行会计处理。',
    '否—质保(或部分质保)除保证产品符合商定的规格外，不向客户提供服务。质保(或部分质保)属于担保型质保，并根据HKAS 37进行会计处理。',
    '是和否——与客户签订的合同包括担保型和服务型质保。请转到第4部分进行进一步评估。'
  ]],
  ['2.3 质保', '2.3-W10', [
    '是—合同同时包括保证型质保和服务型质保。请转到第5部分进行进一步评估。',
    '否—合同不同时包括保证型质保和服务型质保。'
  ]],
  ['2.3 质保', '2.3-W11', [
    '是—保证型质保和服务型质保能够合理分配。请在下面记录分配依据。',
    '否—保证型质保和服务型质保不能合理分配。质保被视为一项单独的履约义务，并在质保服务提供期间予以确认。'
  ]],
  ['3.2 可变对价-测试对象', '3.2-VC3', ['期望值', '最可能发生金额']],
  ['3.2 可变对价-测试对象', '3.2-VC12', [
    '已确认的累计收入金额极可能会发生重大转回，且可变对价的估计会减少，直到达到可纳入交易价格的金额，如果后续在与可变对价相关的不确定性后续消除时被转回，将不会导致已确认累计收入的重大转回。',
    '已确认的累计收入金额极可能不会发生重大转回，因此无需对可变对价进行限制。'
  ]],
  ['3.5 应付客户对价-测试对象', '3.5-PC3', [
    '是—应付客户对价是用于获取可明确区分的商品或服务，请转到第3部分进行进一步评估。',
    '否—应付客户对价不是用于获取可明确区分的商品或服务，因此其应作为交易价格的抵减进行会计处理（结果1）。'
  ]],
  ['3.5 应付客户对价-测试对象', '3.5-PC5', [
    '是—可以可靠估计可明确区分的商品或服务的公允价值，请转到第4部分进行进一步评估。',
    '否—不能可靠估计可明确区分的商品或服务的公允价值，因此其应作为交易价格的抵减进行会计处理（结果1）。'
  ]],
  ['3.5 应付客户对价-测试对象', '3.5-PC6', [
    '是—应付客户对价的金额超过可明确区分的商品或服务的公允价值。对于支付从客户处收到的可明确区分的商品或服务的公允价值的对价，采用与主体向供应商进行的其他采购相同的方式对应付客户对价进行会计处理。超出部分将作为交易价格的抵减进行会计处理。（结果2）',
    '否—应付客户对价的金额没有超过可明确区分的商品或服务的公允价值，因此采用与主体向供应商进行的其他采购相同的方式对对价进行会计处理。（结果3）'
  ]],
  ['5.1.1 时段（PO#1）', '5.1.1-A2', [
    '是 - 主体可合理计量履约进度。请继续第4部分。',
    '否 - 主体无法合理计量履约进度。请在下面载明导致主体无法计量履约进度的情况，并继续第3部分。'
  ]],
  ['5.1.1 时段（PO#1）', '5.1.1-A3', [
    '是 - 预计发生的成本可收回，且仅以发生成本为限可确认收入。',
    '否 - 预计发生的成本不可收回，且在履约进度可合理计量之前，收入不可确认。'
  ]],
  ['5.1.1 时段（PO#1）', '5.1.1-A4', [
    '用产出法计量进度。请在下面填写第5A部分“产出法”。',
    '用投入法计量进度。请在下面填写第5B部分“投入法”。'
  ]],
  ['5.1.1 时段（PO#1）', '5.1.1-O1', [
    '是 - 发票金额与累计至今主体已完成的履约义务对于客户的价值直接相对应。采用“有权开具发票”的实务变通来计量履约进度。',
    '是 - 发票金额与累计至今主体已完成的履约义务对于客户的价值直接相对应。但是，未采用“有权开具发票”的实务变通计量履约进度。',
    '否 - 发票金额与累计至今主体已完成的履约义务对于客户的价值不直接相对应。无法采用“有权开具发票”的实务变通计量履约进度。'
  ]],
  ['5.1.1 时段（PO#1）', '5.1.1-O2', ['测量累计至今的完工进度', '评估已实现的结果', '已达到的里程碑', '时间进度', '已完成或交付的商品或服务单位', '其他 - 请具体说明依据']],
  ['5.1.1 时段（PO#1）', '5.1.1-I1', ['耗费的材料数量', '花费的工时数', '发生的成本', '时间进度', '使用的机器工时', '其他 - 请具体说明依据']],
  ['5.1.1 时段（PO#1）', '5.1.1-I2', [
    '是 - 主体发生未包括在合同价款中的明显低效率情况。因此，需在计量进度时对低效率情况进行调整 - 请具体说明',
    '否 - 主体未发生未包括在合同价款中的明显低效率情况，因此，无需在计量进度时进行调整'
  ]],
  ['5.1.1 时段（PO#1）', '5.1.1-I3', ['是 - 客户所在地存在未安装的材料。', '否 - 客户所在地无未安装的材料。']],
  ['5.1.1 时段（PO#1）', '5.1.1-I4', [
    '是 - 满足所有四个条件，且需在计量履约进度时进行调整。未安装的材料仅以发生的成本为限确认 - 请具体说明调整情况。',
    '否 - 无/未满足所有四个条件，无需进行调整。'
  ]],
  ['5.1.1 时段（PO#1）', '5.1.1-I5', [
    '是 - 计量进度时需进行其他调整 - 请具体说明',
    '否 - 计量进度时无需进行其他调整'
  ]]
);
longDropdowns.forEach(([sheet, no, answers]) => {
  assert.deepEqual(RevenueWorkpaper.answerOptions[no], answers, `${no} 长下拉目录与底稿不一致`);
  answers.forEach((answer) => {
    const result = RevenueWorkpaper.normalizeResults([item(sheet, no, answer, {
      answer_reason: '合同证据支持所选底稿选项。'
    })])[0];
    assert.equal(result.suggested_answer, answer, `${sheet}/${no} 改写了底稿长选项`);
  });
});

const freeTextQuestions = [
  ['1.4 合同变更', '1.4-M1'], ['1.4 合同变更', '1.4-M2'],
  ['1.4 合同变更', '1.4-M3'], ['1.4 合同变更', '1.4-M4'],
  ['1.4 合同变更', '1.4-M6'], ['1.4 合同变更', '1.4-M7'],
  ['2.2.1 PVA-测试对象', '2.2.1-PVA1'], ['2.2.1 PVA-测试对象', '2.2.1-PVA5'],
  ['2.3 质保', '2.3-W1'], ['2.3 质保', '2.3-W4'], ['2.3 质保', '2.3-W5'],
  ['2.3 质保', '2.3-W6'], ['2.3 质保', '2.3-W7'], ['2.3 质保', '2.3-W8'], ['2.3 质保', '2.3-W12'],
  ['3.2 可变对价-测试对象', '3.2-VC1'], ['3.2 可变对价-测试对象', '3.2-VC2'],
  ['3.2 可变对价-测试对象', '3.2-VC4'], ['3.2 可变对价-测试对象', '3.2-VC11'], ['3.2 可变对价-测试对象', '3.2-VC13'],
  ['3.5 应付客户对价-测试对象', '3.5-PC1'], ['3.5 应付客户对价-测试对象', '3.5-PC2'], ['3.5 应付客户对价-测试对象', '3.5-PC4'],
  ['5.1.1 时段（PO#1）', '5.1.1-A1'], ['5.1.2 时点（PO#1）', '5.1.2-C']
];
freeTextQuestions.forEach(([sheet, no]) => {
  assert.equal(RevenueWorkpaper.answerOptions[no], undefined, `${no} 自由文本题不应进入固定答案目录`);
  const answer = '合同原文和项目资料形成的自由文本结论（保持原样）。';
  const result = RevenueWorkpaper.normalizeResults([item(sheet, no, answer, {
    answer_reason: '该单元格不是固定下拉选项。'
  })])[0];
  assert.equal(result.suggested_answer, answer, `${sheet}/${no} 自由文本被错误二元化`);
});

// Confidence and review status are controlled metadata, not model-authored
// prose. Invalid or empty values are normalized conservatively.
['极高', '99%', '确定', '未知', ''].forEach((invalidConfidence) => {
  const result = RevenueWorkpaper.normalizeResults([item('第3步', '3.3', '是', {
    confidence: invalidConfidence,
    review_status: 'AI已确认，无需复核',
    contract_excerpt: '付款和履约时间安排见合同相关条款。',
    answer_reason: '现有合同资料支持选择“是”，但元数据值不是系统允许的枚举。'
  })])[0];
  assert.equal(result.suggested_answer, '是');
  assert.equal(result.confidence, '低', `非法置信度未归为低：${invalidConfidence || '空值'}`);
  assert.equal(result.review_status, '需人工复核');
});

['无需复核', '已确认', '自动通过', '待判断', ''].forEach((invalidReviewStatus) => {
  const result = RevenueWorkpaper.normalizeResults([item('第3步', '3.4', '否', {
    confidence: '高',
    review_status: invalidReviewStatus,
    answer_reason: '合同未约定非现金对价。'
  })])[0];
  assert.equal(result.suggested_answer, '否');
  assert.equal(result.review_status, '需人工复核', `非法复核状态未归一：${invalidReviewStatus || '空值'}`);
});

console.log('Revenue fixed-answer checks passed.');
