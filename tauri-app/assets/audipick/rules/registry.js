// AudiPick 提取规则注册表与引擎
(function (global) {
  var ORDER = [
    'loan_covenant', 'loan_general', 'revenue', 'revenue_workpaper', 'procurement', 'invoicing_agreement',
    'statement', 'invoice', 'warehouse_io', 'account_opening', 'tax_declaration',
    'credit_report', 'tax_audit_report'
  ];

  var RULE_GROUPS = [
    { id: 'contract', label: '合同协议', categories: ['loan', 'revenue', 'procurement', 'agreement'] },
    { id: 'voucher', label: '单据票证', categories: ['voucher'] },
    { id: 'report', label: '报告', categories: ['report'] }
  ];

  var META = {
    loan_covenant: {
      id: 'loan_covenant',
      name: '借款·限制性契约',
      shortName: '限制性契约',
      category: 'loan',
      docKind: 'clause',
      version: '1.0',
      readonly: true,
      description: '窄口径：仅摘录银行借款合同中的限制性契约（covenant）条款，适用于债项 covenant 测试底稿。',
      useCase: '用于从银行借款合同中识别财务/非财务限制性契约（covenant），支撑债项 covenant 合规测试。',
      example: { category: '财务比率约束', quote: '资产负债率不得超过65%……', hint: '关注报告期是否触发 breach 及是否取得 waiver' }
    },
    loan_general: {
      id: 'loan_general',
      name: '借款·通用条款',
      shortName: '借款通用',
      category: 'loan',
      docKind: 'clause',
      version: '1.1',
      readonly: true,
      description: '摘录银行借款/融资租赁等债务合同中影响长短期债务分类、利息测算、抵质押披露及违约风险的核心条款。',
      useCase: '用于从银行借款、融资租赁等债务合同中摘录借款基本要素、利率计息、还款计划、担保抵质押及限制性契约。',
      example: { category: '借款基本要素', quote: '贷款金额为人民币5,000万元，期限36个月……', hint: '关注一年内到期的非流动负债重分类，结合提款日及还款计划逐笔倒算' }
    },
    revenue: {
      id: 'revenue',
      name: '收入合同',
      shortName: '收入',
      category: 'revenue',
      docKind: 'clause',
      version: '1.1',
      readonly: true,
      description: '摘录收入/销售合同中影响收入确认时点、金额及履约义务的核心商务条款，服务于新收入准则测试。',
      useCase: '用于从收入、销售合同中识别履约义务、控制权转移、可变对价、结算付款及质保退换货等条款。',
      example: { category: '控制权转移与验收', quote: '客户终验合格并签署验收报告后视为交付完成……', hint: '关注控制权转移时点证据，评估按时点或按时段确认收入' }
    },
    revenue_workpaper: {
      id: 'revenue_workpaper',
      name: '收入合同审阅底稿',
      shortName: '收入底稿套用',
      category: 'revenue',
      docKind: 'clause',
      workpaperMode: 'revenue_v2',
      version: '1.3',
      readonly: true,
      description: '将主合同和补充资料合并为共享事实表，统一回答V2收入底稿问题，并把缺失资料转化为可上传、可追踪的复核任务。',
      useCase: '用于把收入合同摘录信息对应到收入确认五步法底稿问题，先形成可复核填列清单，再由项目组确认后套用。',
      example: { category: '第3步 / 3.2', quote: '年度累计采购达到约定金额后，卖方按销售额的3%给予返利。', hint: '建议回答“是”，并将返利条款、页码和需复核的可变对价判断一并列入清单' }
    },
    procurement: {
      id: 'procurement',
      name: '采购合同',
      shortName: '采购',
      category: 'procurement',
      docKind: 'clause',
      version: '1.1',
      readonly: true,
      description: '摘录采购/供应商合同中影响存货计价、成本确认、暂估入账及应付账款测算的核心商务条款。',
      useCase: '用于从采购、供应商合同中识别定价调价、交付风险转移、结算信用期、质量退损及违约赔偿等条款。',
      example: { category: '交付与风险转移', quote: '货物送达指定仓库并入库后风险转移……', hint: '截止性测试重点：核对风险转移单据日期与财务入账日期' }
    },
    invoicing_agreement: {
      id: 'invoicing_agreement',
      name: '银行承兑汇票开票协议',
      shortName: '银承开票协议',
      category: 'agreement',
      docKind: 'clause',
      version: '1.1',
      readonly: true,
      description: '摘录银承开立协议、承兑合同或授信子合同中影响应付票据列报、货币资金受限披露及垫款违约风险的核心条款。',
      useCase: '用于从银行承兑汇票开立协议中识别票据要素、保证金与受限资金、费用敞口及银行垫款违约条款。',
      example: { category: '保证金与受限资金', quote: '开立承兑汇票须缴存票面金额30%的保证金……', hint: '测算应缴保证金并与其他货币资金及附注受限披露核对' }
    },
    statement: {
      id: 'statement',
      name: '对账单',
      shortName: '对账单',
      category: 'voucher',
      docKind: 'table',
      version: '1.0',
      readonly: true,
      description: '从银行/企业对账单 OCR 文本中逐行提取交易明细（日期、摘要、借贷方、余额），输出制式表格 JSON。',
      useCase: '用于从银行或企业对账单中提取逐笔交易明细，生成结构化表格。',
      example: { category: '交易明细', quote: '2024-03-15 转账收入 50,000.00 余额 1,230,000.00', hint: '核对与银行流水及账簿记录一致' }
    },
    invoice: {
      id: 'invoice',
      name: '发票',
      shortName: '发票',
      category: 'voucher',
      docKind: 'table',
      version: '1.0',
      readonly: true,
      description: '从发票 OCR 文本中提取代码、号码、购销方、金额、税额等票面要素，输出制式 JSON。',
      useCase: '用于从发票中提取代码、号码、购销方、金额、税额等票面要素。',
      example: { category: '票面要素', quote: '购买方：XX公司  价税合计 ¥11,300.00', hint: '核对与入账凭证及合同一致性' }
    },
    warehouse_io: {
      id: 'warehouse_io',
      name: '出入库单',
      shortName: '出入库',
      category: 'voucher',
      docKind: 'table',
      version: '1.0',
      readonly: true,
      description: '从出入库单/领料单 OCR 文本中逐行提取品名、数量、单价、金额等明细。',
      useCase: '用于从出入库单、领料单中提取品名、数量、单价、金额等明细行。',
      example: { category: '出库明细', quote: '产品A  100件  单价50元  金额5,000元', hint: '核对与库存记录及成本结转' }
    },
    account_opening: {
      id: 'account_opening',
      name: '开户清单',
      shortName: '开户清单',
      category: 'voucher',
      docKind: 'table',
      version: '1.0',
      readonly: true,
      description: '从开户清单/账户列表 OCR 文本中逐行提取户名、账号、开户行、账户类型等信息。',
      useCase: '用于从开户清单、账户列表中提取户名、账号、开户行、账户类型等信息。',
      example: { category: '账户信息', quote: '户名：XX有限公司  账号：6222****  开户行：工商银行', hint: '核对与银行询证及账面记录' }
    },
    credit_report: {
      id: 'credit_report',
      name: '征信报告',
      shortName: '征信',
      category: 'report',
      docKind: 'clause',
      version: '1.0',
      readonly: true,
      description: '从征信报告 OCR 文本中摘录信贷记录、担保、公共记录、查询记录等对审计有实质影响的信息项。',
      useCase: '用于从征信报告中摘录信贷记录、担保、公共记录、查询记录等对审计有实质影响的信息。',
      example: { category: '信贷记录', quote: '授信额度5,000万，已用3,200万，五级分类正常', hint: '关注逾期、展期及关联担保披露' }
    },
    tax_declaration: {
      id: 'tax_declaration',
      name: '纳税申报表',
      shortName: '纳税申报表',
      category: 'voucher',
      docKind: 'table',
      version: '1.0',
      readonly: true,
      description: '从增值税、企业所得税等纳税申报表 OCR 文本中提取行次、项目与金额，输出制式表格 JSON。',
      useCase: '用于从增值税、企业所得税等纳税申报表中提取行次、项目与申报金额。',
      example: { category: '申报项目', quote: '应纳税销售额 12,500,000.00  销项税额 1,625,000.00', hint: '核对与账面收入及税负分析' }
    },
    tax_audit_report: {
      id: 'tax_audit_report',
      name: '税审报告',
      shortName: '税审报告',
      category: 'report',
      docKind: 'clause',
      version: '1.0',
      readonly: true,
      description: '从税务鉴证/税审报告 OCR 文本中摘录结论、纳税调整、税种认定等对税务底稿有实质影响的信息项。',
      useCase: '用于从税务鉴证、税审报告中摘录结论、纳税调整、税种认定等关键信息。',
      example: { category: '鉴证结论', quote: '我们认为，贵公司上述企业所得税汇算清缴在所有重大方面符合规定……', hint: '关注调整事项对当期所得税的影响' }
    }
  };

  function buildPresets() {
    var prompts = global.RULE_PROMPTS || {};
    var presets = {};
    ORDER.forEach(function (id) {
      presets[id] = Object.assign({}, META[id], { prompt: prompts[id] || '' });
    });
    return presets;
  }

  global.RULE_ORDER = ORDER.slice();
  global.RULE_GROUPS = RULE_GROUPS.slice();
  global.RULE_PRESETS = buildPresets();

  function getRulesInGroup(groupId) {
    var g = RULE_GROUPS.find(function (x) { return x.id === groupId; });
    if (!g) return [];
    return ORDER.filter(function (id) {
      var m = META[id];
      return m && g.categories.indexOf(m.category) >= 0;
    }).map(function (id) { return getRule(id); }).filter(Boolean);
  }

  var fieldsCache = {};

  function parseFieldsFromPrompt(prompt) {
    var fields = [];
    if (!prompt) return fields;
    var start = prompt.indexOf('【字段定义】');
    if (start < 0) return fields;
    var rest = prompt.slice(start + 5);
    var endM = rest.match(/\n【[^】]+】/);
    var block = endM ? rest.slice(0, endM.index) : rest;
    block.split(/\r?\n/).forEach(function (line) {
      var m = line.match(/^\s*([A-Za-z_][\w\u4e00-\u9fa5]*)\s*[:：]\s*(.+)$/);
      if (!m) return;
      var key = m[1].trim();
      var tail = m[2].trim();
      var label = tail.replace(/[（(].*$/, '').trim() || key;
      if (key && fields.filter(function (f) { return f.key === key; }).length === 0) {
        fields.push({ key: key, label: label });
      }
    });
    return fields;
  }

  function isCustomRuleId(id) {
    return id && String(id).indexOf('custom_') === 0;
  }

  function getCustomRules() {
    return global.__CUSTOM_RULES || [];
  }

  function setCustomRules(list) {
    global.__CUSTOM_RULES = list || [];
  }

  function getRule(id) {
    if (!id) return null;
    if (isCustomRuleId(id)) {
      return getCustomRules().find(function (r) { return r.id === id; }) || null;
    }
    return global.RULE_PRESETS[id] || null;
  }

  function getRulePrompt(id) {
    var r = getRule(id);
    return r ? r.prompt : '';
  }

  function getRuleName(id) {
    var r = getRule(id);
    return r ? (r.name || r.shortName || id) : id;
  }

  function getRuleShortName(id) {
    var r = getRule(id);
    return r ? (r.shortName || r.name || id) : id;
  }

  function getAllSelectableRules() {
    var list = [];
    ORDER.forEach(function (id) {
      var r = getRule(id);
      if (r) list.push(r);
    });
    getCustomRules().forEach(function (r) {
      list.push(r);
    });
    return list;
  }

  function getFieldsForRule(ruleId) {
    if (!ruleId) ruleId = ORDER[0];
    if (fieldsCache[ruleId]) return fieldsCache[ruleId];
    var prompt = getRulePrompt(ruleId);
    var fields = parseFieldsFromPrompt(prompt);
    if (fields.length === 0) {
      for (var i = 1; i <= 10; i++) fields.push({ key: 'c' + i, label: 'c' + i });
    }
    fieldsCache[ruleId] = fields;
    return fields;
  }

  function resetFieldsCache(ruleId) {
    if (ruleId) delete fieldsCache[ruleId];
    else fieldsCache = {};
  }

  function pageKeyForRule(ruleId) {
    var fs = getFieldsForRule(ruleId);
    for (var i = 0; i < fs.length; i++) {
      if (/page|页/i.test(fs[i].key)) return fs[i].key;
    }
    return null;
  }

  function copyBuiltinAsCustom(builtinId, customName) {
    var base = getRule(builtinId);
    if (!base) return null;
    var id = 'custom_' + Date.now();
    var rule = {
      id: id,
      name: customName || (base.name + '（自定义）'),
      shortName: customName || base.shortName || base.name,
      category: base.category || 'custom',
      version: '1.0',
      readonly: false,
      baseRuleId: builtinId,
      docKind: base.docKind || 'contract',
      description: '基于「' + base.name + '」复制的自定义模板',
      useCase: base.useCase || base.description || '',
      example: base.example || null,
      prompt: base.prompt
    };
    var list = getCustomRules();
    list.push(rule);
    setCustomRules(list);
    resetFieldsCache(id);
    return rule;
  }

  function blankPromptSkeleton(docKind) {
    if (docKind === 'table') {
      return '【字段定义】\npage: 页码\ndate: 日期\nsummary: 摘要\namount: 金额\nremark: 备注\n\n【提取要求】\n请从文档中逐行提取与审计目标相关的明细信息。\n\n【输出要求】\n只输出JSON，格式为：{"items":[{"page":"","date":"","summary":"","amount":"","remark":""}]}';
    }
    return '【字段定义】\npage: 页码\ncategory: 条款类别\nexcerpt: 原文摘录\naudit_hint: 审计提示\nremark: 备注\n\n【提取要求】\n请从文档中提取与审计目标相关的关键条款或重要信息。\n\n【输出要求】\n只输出JSON，格式为：{"items":[{"page":"","category":"","excerpt":"","audit_hint":"","remark":""}]}';
  }

  function createBlankCustomRule(customName, docKind) {
    var name = customName || '我的空白模板';
    var kind = docKind === 'table' ? 'table' : 'contract';
    var id = 'custom_' + Date.now();
    var rule = {
      id: id,
      name: name,
      shortName: name,
      category: 'custom',
      version: '1.0',
      readonly: false,
      docKind: kind,
      description: '从空白提示词创建的自定义模板',
      useCase: '适用于需要自行定义字段与提取规则的文档。',
      example: null,
      prompt: blankPromptSkeleton(kind)
    };
    var list = getCustomRules();
    list.push(rule);
    setCustomRules(list);
    resetFieldsCache(id);
    return rule;
  }

  function updateCustomRule(id, patch) {
    var list = getCustomRules();
    var idx = list.findIndex(function (r) { return r.id === id; });
    if (idx < 0) return false;
    list[idx] = Object.assign({}, list[idx], patch || {});
    setCustomRules(list);
    resetFieldsCache(id);
    return true;
  }

  function deleteCustomRule(id) {
    var list = getCustomRules().filter(function (r) { return r.id !== id; });
    setCustomRules(list);
    resetFieldsCache(id);
  }

  function getContractDefaultRuleId(contract, project) {
    if (contract && contract.ruleId) return contract.ruleId;
    if (project && project.defaultRuleId && getRule(project.defaultRuleId)) return project.defaultRuleId;
    return ORDER[0];
  }

  global.RuleEngine = {
    ORDER: ORDER,
    RULE_GROUPS: RULE_GROUPS,
    buildPresets: buildPresets,
    getRulesInGroup: getRulesInGroup,
    parseFieldsFromPrompt: parseFieldsFromPrompt,
    isCustomRuleId: isCustomRuleId,
    getCustomRules: getCustomRules,
    setCustomRules: setCustomRules,
    getRule: getRule,
    getRulePrompt: getRulePrompt,
    getRuleName: getRuleName,
    getRuleShortName: getRuleShortName,
    getAllSelectableRules: getAllSelectableRules,
    getFieldsForRule: getFieldsForRule,
    resetFieldsCache: resetFieldsCache,
    pageKeyForRule: pageKeyForRule,
    copyBuiltinAsCustom: copyBuiltinAsCustom,
    createBlankCustomRule: createBlankCustomRule,
    updateCustomRule: updateCustomRule,
    deleteCustomRule: deleteCustomRule,
    getContractDefaultRuleId: getContractDefaultRuleId
  };

  // 重新合并内置规则（prompt 脚本加载后可调用）
  global.refreshRulePresets = function () {
    global.RULE_PRESETS = buildPresets();
    resetFieldsCache();
  };
})(window);
