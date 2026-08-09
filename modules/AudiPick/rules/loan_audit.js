(function (root, factory) {
  var api = factory(root || {});
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LoanAudit = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function (global) {
  'use strict';

  var state = { view: 'dashboard', expandedCards: {} };
  var EMPTY_VALUES = ['未明确', '不适用', '无', '暂无', '-', '--', 'null', 'undefined'];
  var CURRENCY_NAMES = {
    CNY: '人民币', USD: '美元', HKD: '港币', EUR: '欧元', JPY: '日元', GBP: '英镑',
    AUD: '澳元', CAD: '加元', SGD: '新加坡元', CHF: '瑞士法郎'
  };

  function list(value) { return Array.isArray(value) ? value : []; }
  function text(value) { return value === null || value === undefined ? '' : String(value).trim(); }
  function known(value) {
    var valueText = text(value);
    return !!valueText && EMPTY_VALUES.indexOf(valueText.toLowerCase()) < 0;
  }
  function firstValue(source, keys) {
    source = source || {};
    for (var index = 0; index < keys.length; index++) {
      if (known(source[keys[index]])) return source[keys[index]];
    }
    return '';
  }
  function pad(value) { return value < 10 ? '0' + value : String(value); }
  function escapeHtml(value) {
    return text(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function attr(value) { return escapeHtml(value); }
  function jsArg(value) { return JSON.stringify(String(value || '')).replace(/</g, '\\u003c'); }
  function safeId(value) { return text(value).replace(/[^a-zA-Z0-9_-]/g, '_'); }
  function dateFromParts(year, month, day) {
    year = Number(year); month = Number(month); day = Number(day);
    if (!year || month < 1 || month > 12 || day < 1 || day > 31) return null;
    var date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return date;
  }
  function isoDate(date) {
    return date ? date.getUTCFullYear() + '-' + pad(date.getUTCMonth() + 1) + '-' + pad(date.getUTCDate()) : '';
  }
  function chineseQuarter(value) {
    return { '一': 1, '二': 2, '三': 3, '四': 4 }[value] || Number(value) || 0;
  }
  function quarterEnd(year, quarter) {
    return dateFromParts(year, quarter * 3, [31, 30, 30, 31][quarter - 1]);
  }
  function dateMatches(value) {
    var source = text(value);
    var matches = [];
    var regular = /(20\d{2}|19\d{2})\s*(?:年|[-\/.])\s*(\d{1,2})\s*(?:月|[-\/.])\s*(\d{1,2})\s*日?/g;
    var quarter = /(20\d{2}|19\d{2})\s*年?\s*(?:第\s*)?([一二三四1234])\s*(?:季度|季)\s*末/g;
    var englishQuarter = /(20\d{2}|19\d{2})\s*[-\/]?\s*Q([1-4])/gi;
    var match;
    while ((match = regular.exec(source))) {
      var regularDate = dateFromParts(match[1], match[2], match[3]);
      if (regularDate) matches.push({ index: match.index, length: match[0].length, date: regularDate, iso: isoDate(regularDate), raw: match[0] });
    }
    while ((match = quarter.exec(source))) {
      var quarterDate = quarterEnd(Number(match[1]), chineseQuarter(match[2]));
      if (quarterDate) matches.push({ index: match.index, length: match[0].length, date: quarterDate, iso: isoDate(quarterDate), raw: match[0], quarterEnd: true });
    }
    while ((match = englishQuarter.exec(source))) {
      var qDate = quarterEnd(Number(match[1]), Number(match[2]));
      if (qDate) matches.push({ index: match.index, length: match[0].length, date: qDate, iso: isoDate(qDate), raw: match[0], quarterEnd: true });
    }
    matches.sort(function (left, right) { return left.index - right.index || right.length - left.length; });
    var occupied = {};
    return matches.filter(function (entry) {
      var key = entry.index + ':' + entry.iso;
      if (occupied[key]) return false;
      occupied[key] = true;
      return true;
    });
  }
  function parseDate(value) {
    var matches = dateMatches(value);
    return matches.length ? matches[0] : null;
  }

  function normalizeCurrency(value) {
    var source = text(value).toUpperCase().replace(/\s+/g, '');
    if (!source) return '';
    if (/人民币|RMB|CNY|￥|¥/.test(source)) return 'CNY';
    if (/美元|美金|USD|US\$/.test(source) || /^\$/.test(source)) return 'USD';
    if (/港币|港元|HKD|HK\$/.test(source)) return 'HKD';
    if (/欧元|EUR|€/.test(source)) return 'EUR';
    if (/日元|JPY|JP¥/.test(source)) return 'JPY';
    if (/英镑|GBP|£/.test(source)) return 'GBP';
    if (/澳元|AUD|A\$/.test(source)) return 'AUD';
    if (/加元|CAD|C\$/.test(source)) return 'CAD';
    if (/新加坡元|新币|SGD|S\$/.test(source)) return 'SGD';
    if (/瑞士法郎|CHF/.test(source)) return 'CHF';
    if (CURRENCY_NAMES[source]) return source;
    return '';
  }
  function chineseNumber(value) {
    var digits = { '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
      '壹': 1, '贰': 2, '叁': 3, '肆': 4, '伍': 5, '陆': 6, '柒': 7, '捌': 8, '玖': 9 };
    var units = { '十': 10, '拾': 10, '百': 100, '佰': 100, '千': 1000, '仟': 1000 };
    var total = 0; var section = 0; var number = 0;
    for (var index = 0; index < value.length; index++) {
      var character = value.charAt(index);
      if (Object.prototype.hasOwnProperty.call(digits, character)) { number = digits[character]; continue; }
      if (units[character]) { section += (number || 1) * units[character]; number = 0; continue; }
      if (character === '万') { section += number; total += section * 10000; section = 0; number = 0; continue; }
      if (character === '亿') { section += number; total = (total + section) * 100000000; section = 0; number = 0; }
    }
    return total + section + number;
  }
  function parseAmount(value, fallbackCurrency) {
    var raw = text(value);
    var currency = normalizeCurrency(raw) || normalizeCurrency(fallbackCurrency);
    if (!known(raw)) return { raw: raw, currency: currency, amount: null, valid: false, unit: '' };
    var compact = raw.replace(/[，,\s]/g, '');
    var numeric = compact.match(/(-?\d+(?:\.\d+)?)\s*(千万元|亿元|万元|千元|百万元|亿|万|千|元|BILLION|MILLION|THOUSAND)?/i);
    var amount = null; var unit = '';
    if (numeric) {
      amount = Number(numeric[1]); unit = (numeric[2] || '').toLowerCase();
      var factors = { '元': 1, '千': 1000, '千元': 1000, '万': 10000, '万元': 10000, '百万元': 1000000,
        '千万元': 10000000, '亿': 100000000, '亿元': 100000000, 'thousand': 1000, 'million': 1000000, 'billion': 1000000000 };
      amount *= factors[unit] || 1;
    } else {
      var chinese = compact.match(/([零〇一二两三四五六七八九十百千万亿壹贰叁肆伍陆柒捌玖拾佰仟]+)(亿元|万元|元)?/);
      if (chinese) {
        amount = chineseNumber(chinese[1]); unit = chinese[2] || '';
        if (unit === '万元') amount *= 10000;
        if (unit === '亿元') amount *= 100000000;
      }
    }
    if (!isFinite(amount)) amount = null;
    return { raw: raw, currency: currency, amount: amount, valid: amount !== null, unit: unit };
  }
  function formatAmount(amount, currency) {
    if (amount === null || amount === undefined || !isFinite(amount)) return '待明确';
    var label = CURRENCY_NAMES[currency] || currency || '';
    return label + (label ? ' ' : '') + Number(amount).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  }
  function meaningfulRiskText(value, emptyPattern) {
    var valueText = text(value);
    return known(valueText) && !(emptyPattern || /未发现|无明确|无相关|不适用|信用方式/).test(valueText);
  }
  function addValidation(validations, level, code, message, debt) {
    validations.push({ level: level, code: code, message: message, debtId: debt ? debt.id : '', contractId: debt ? debt.contractId : '' });
  }
  function relationIndex(context) {
    var memberOwner = {}; var memberInfo = {}; var groupsByAnchor = {};
    list(context.relationGroups).forEach(function (group) {
      if (!group || !group.anchorFileId) return;
      groupsByAnchor[group.anchorFileId] = group;
      list(group.members).forEach(function (member) {
        if (!member || !member.fileId) return;
        memberOwner[member.fileId] = group.anchorFileId;
        memberInfo[member.fileId] = member;
      });
    });
    return { memberOwner: memberOwner, memberInfo: memberInfo, groupsByAnchor: groupsByAnchor };
  }
  function recurringQuarterAmount(scheduleText, currency) {
    var match = text(scheduleText).match(/每(?:个)?(?:一)?季(?:度)?末(?:月)?[^；。\n]{0,12}?(?:偿还|归还|支付|还本)[^；。\n]{0,8}?((?:人民币|美元|港币|欧元|日元|英镑|RMB|CNY|USD|HKD|EUR|JPY|GBP|￥|¥|\$)?\s*\d[\d,，]*(?:\.\d+)?\s*(?:亿元|万元|千万元|百万元|千元|元|亿|万|million|billion|thousand))/i);
    return match ? parseAmount(match[1], currency) : { raw: '', currency: normalizeCurrency(currency), amount: null, valid: false };
  }
  function dateRangeForQuarterly(scheduleText, debt) {
    var matches = dateMatches(scheduleText);
    if (matches.length >= 2 && /(?:自|从|起始|开始)[^；。\n]{0,30}(?:至|到|截至)/.test(scheduleText)) {
      return { start: matches[0], end: matches[matches.length - 1], source: '还款条款明确起止日' };
    }
    if (debt.startDate && debt.maturityDate) return { start: debt.startDate, end: debt.maturityDate, source: '借款起止日' };
    return null;
  }
  function expandQuarterEnds(startEntry, endEntry) {
    var rows = [];
    if (!startEntry || !endEntry || startEntry.date > endEntry.date) return rows;
    var startYear = startEntry.date.getUTCFullYear(); var endYear = endEntry.date.getUTCFullYear();
    for (var year = startYear; year <= endYear; year++) {
      for (var quarter = 1; quarter <= 4; quarter++) {
        var date = quarterEnd(year, quarter);
        if (date >= startEntry.date && date <= endEntry.date) rows.push({ date: date, iso: isoDate(date), quarterEnd: true });
      }
    }
    return rows;
  }
  function addMonths(date, count) {
    if (!date) return null;
    var copy = new Date(date.getTime());
    copy.setUTCMonth(copy.getUTCMonth() + count);
    return copy;
  }
  function monthKeyFromDate(date) {
    return date ? date.getUTCFullYear() + '-' + pad(date.getUTCMonth() + 1) : '';
  }
  function monthRange(firstKey, lastKey) {
    if (!firstKey || !lastKey) return [];
    var first = firstKey.match(/^(\d{4})-(\d{2})$/); var last = lastKey.match(/^(\d{4})-(\d{2})$/);
    if (!first || !last) return [];
    var cursor = dateFromParts(Number(first[1]), Number(first[2]), 1);
    var end = dateFromParts(Number(last[1]), Number(last[2]), 1);
    var months = []; var guard = 0;
    while (cursor && end && cursor <= end && guard < 600) {
      months.push(monthKeyFromDate(cursor)); cursor = addMonths(cursor, 1); guard++;
    }
    return months;
  }
  function stripDateTokens(value) {
    return text(value)
      .replace(/(?:20\d{2}|19\d{2})\s*(?:年|[-\/.])\s*\d{1,2}\s*(?:月|[-\/.])\s*\d{1,2}\s*日?/g, '')
      .replace(/(?:20\d{2}|19\d{2})\s*年?\s*(?:第\s*)?[一二三四1234]\s*(?:季度|季)\s*末/g, '')
      .replace(/(?:20\d{2}|19\d{2})\s*[-\/]?\s*Q[1-4]/gi, '');
  }
  function explicitRepayments(scheduleText, debt) {
    var source = text(scheduleText); var matches = dateMatches(source); var rows = [];
    matches.forEach(function (entry, index) {
      var nextIndex = matches[index + 1] ? matches[index + 1].index : source.length;
      var after = source.substring(entry.index + entry.length, nextIndex);
      var previousIndex = index ? matches[index - 1].index + matches[index - 1].length : 0;
      var before = source.substring(previousIndex, entry.index);
      var amount = parseAmount(stripDateTokens(after), debt.currency);
      if (!amount.valid) amount = parseAmount(stripDateTokens(before), debt.currency);
      rows.push({
        debtId: debt.id, contractId: debt.contractId, contractNo: debt.contractNo, date: entry.iso,
        currency: amount.currency || debt.currency, amount: amount.valid ? amount.amount : null,
        amountText: amount.valid ? amount.raw : (/本金[^；。\n]{0,8}\d+(?:\.\d+)?%/.test(after) ? after.match(/本金[^；。\n]{0,8}\d+(?:\.\d+)?%/)[0] : '待明确'),
        source: entry.quarterEnd ? '明确季度末' : '明确日期', inferred: false,
        status: amount.valid ? '明确' : '金额待明确'
      });
    });
    return rows;
  }
  function buildRepayment(debt, validations) {
    var scheduleText = text(debt.raw.repayment_schedule);
    var method = text(debt.raw.repayment_method);
    var quarterly = /每(?:个)?(?:一)?季(?:度)?末|按季末/.test(scheduleText);
    var rows = [];
    var pendingReason = '';
    if (quarterly) {
      var range = dateRangeForQuarterly(scheduleText, debt);
      if (!range) {
        pendingReason = '“每季度末”未提供明确起止日，不展开还款日期';
        addValidation(validations, 'warning', 'quarter_range_missing', pendingReason, debt);
      } else {
        var recurring = recurringQuarterAmount(scheduleText, debt.currency);
        rows = expandQuarterEnds(range.start, range.end).map(function (entry) {
          return {
            debtId: debt.id, contractId: debt.contractId, contractNo: debt.contractNo, date: entry.iso,
            currency: recurring.currency || debt.currency, amount: recurring.valid ? recurring.amount : null,
            amountText: recurring.valid ? recurring.raw : '待明确', source: '每季度末（' + range.source + '）',
            inferred: true, status: recurring.valid ? '日期展开、单期金额明确' : '仅展开日期，金额待明确'
          };
        });
        if (!rows.length) {
          pendingReason = '季度起止日无有效季度末日期';
          addValidation(validations, 'warning', 'quarter_no_dates', pendingReason, debt);
        }
      }
    } else if (known(scheduleText) && !/无单独还款计划|到期一次还本/.test(scheduleText)) {
      rows = explicitRepayments(scheduleText, debt);
    }
    if (!rows.length && /到期一次还本|一次性还本/.test(method + ' ' + scheduleText)) {
      if (debt.maturityDate) {
        rows.push({
          debtId: debt.id, contractId: debt.contractId, contractNo: debt.contractNo, date: debt.maturityDate.iso,
          currency: debt.currency, amount: debt.principal, amountText: debt.principalText || '合同本金',
          source: '到期一次还本推定', inferred: true, status: debt.principal === null ? '日期明确，金额待明确' : '推定'
        });
      } else {
        pendingReason = '到期一次还本但到期日未明确';
        addValidation(validations, 'warning', 'maturity_missing', pendingReason, debt);
      }
    }
    if (!rows.length && !pendingReason) {
      pendingReason = '无法从现有条款确定还款日期';
      addValidation(validations, 'warning', 'repayment_unclear', pendingReason, debt);
    }
    return { status: rows.length ? (rows.some(function (row) { return row.amount === null; }) ? '部分待明确' : '已解析') : '待明确', rows: rows, pendingReason: pendingReason, raw: scheduleText || method };
  }
  function positiveStatus(value, pattern) {
    var valueText = text(value);
    return known(valueText) && pattern.test(valueText) && !/未发现|无限制|未明确|不适用/.test(valueText);
  }
  function riskItems(debt, covenantItems, reportDate) {
    var risks = [];
    var interestText = [debt.raw.interest_rate_type, debt.raw.interest_rate, debt.raw.interest_method].join(' ');
    if (/浮动|LPR|SOFR|HIBOR|SHIBOR|基准利率|基点|\bBP\b|加点|减点/i.test(interestText)) {
      risks.push({ type: 'floating_rate', label: '浮动利率重定价', severity: 'medium', detail: text(debt.raw.interest_rate) || text(debt.raw.interest_method) });
    }
    var secured = /保证|抵押|质押|混合担保/.test(text(debt.raw.loan_nature)) || meaningfulRiskText(debt.raw.guarantor) || meaningfulRiskText(debt.raw.security_summary);
    if (secured) {
      risks.push({ type: 'security', label: '担保及权利受限', severity: 'medium', detail: [debt.raw.loan_nature, debt.raw.guarantor, debt.raw.security_summary].filter(known).join('；') });
    }
    var covenantText = text(debt.raw.covenant_summary);
    if (meaningfulRiskText(covenantText) || covenantItems.length) {
      var details = [];
      if (meaningfulRiskText(covenantText)) details.push(covenantText);
      covenantItems.forEach(function (item) { details.push(text(item.title) || text(item.auditor_summary) || text(item.excerpt)); });
      risks.push({ type: 'covenant', label: '限制性条款及违约触发', severity: /提前到期|加速到期|取消授信|违约/.test(details.join(' ')) ? 'high' : 'medium', detail: details.filter(known).join('；') });
    }
    if (positiveStatus(debt.raw.prepayment_restriction_status, /有限制/) || /提前还款.{0,20}(同意|通知|补偿|违约金|手续费|最低|限制)/.test(text(debt.raw.prepayment_default))) {
      risks.push({ type: 'prepayment', label: '提前还款存在限制', severity: 'medium', detail: text(debt.raw.prepayment_default) || text(debt.raw.prepayment_restriction_status) });
    }
    if (positiveStatus(debt.raw.financial_covenant_status, /存在明确财务指标约束/)) {
      risks.push({ type: 'financial_covenant', label: '存在财务指标约束', severity: 'medium', detail: text(debt.raw.covenant_summary) || text(debt.raw.financial_covenant_status) });
    }
    if (positiveStatus(debt.raw.acceleration_or_material_default_trigger_status, /存在明确触发/)) {
      risks.push({ type: 'acceleration', label: '存在加速到期触发', severity: 'high', detail: text(debt.raw.prepayment_default) || text(debt.raw.acceleration_or_material_default_trigger_status) });
    }
    var resetDate = parseDate(debt.raw.next_interest_rate_adjustment_date);
    if (reportDate && resetDate) {
      var daysToReset = Math.ceil((resetDate.date - reportDate.date) / 86400000);
      if (daysToReset >= 0 && daysToReset <= 60) {
        risks.push({ type: 'rate_reset_soon', label: '利率调整日临近', severity: 'medium', detail: resetDate.iso + '，距报告日' + daysToReset + '天' });
      }
    }
    return risks;
  }
  function buildMonthlyMatrix(debts, reportYear) {
    var monthMap = {};
    if (reportYear && !debts.some(function (debt) { return debt.repayment.rows.length; })) {
      for (var month = 1; month <= 12; month++) monthMap[reportYear + '-' + pad(month)] = true;
    }
    debts.forEach(function (debt) { debt.repayment.rows.forEach(function (row) { if (row.date) monthMap[row.date.substring(0, 7)] = true; }); });
    var eventMonths = Object.keys(monthMap).sort();
    var months = eventMonths.length ? monthRange(eventMonths[0], eventMonths[eventMonths.length - 1]) : [];
    var totalsByCurrency = {};
    var rows = debts.map(function (debt) {
      var cells = {};
      debt.repayment.rows.forEach(function (row) {
        var monthKey = row.date.substring(0, 7);
        if (!cells[monthKey]) cells[monthKey] = { entries: [], amount: 0, hasAmount: false, hasUncertain: false };
        cells[monthKey].entries.push(row);
        if (row.amount === null) cells[monthKey].hasUncertain = true;
        else { cells[monthKey].amount += row.amount; cells[monthKey].hasAmount = true; }
        if (row.amount !== null) {
          var currency = row.currency || debt.currency || '未明确';
          if (!totalsByCurrency[currency]) totalsByCurrency[currency] = {};
          totalsByCurrency[currency][monthKey] = (totalsByCurrency[currency][monthKey] || 0) + row.amount;
        }
      });
      Object.keys(cells).forEach(function (key) { if (!cells[key].hasAmount) cells[key].amount = null; });
      return { debtId: debt.id, contractId: debt.contractId, contractNo: debt.contractNo, contractName: debt.contractName, currency: debt.currency, cells: cells };
    });
    var rowByDebtId = {}; rows.forEach(function (row) { rowByDebtId[row.debtId] = row; });
    return { months: months, rows: rows, rowByDebtId: rowByDebtId, totalsByCurrency: totalsByCurrency };
  }
  function latestLoanResults(results, relations) {
    var grouped = {};
    list(results).forEach(function (item, index) {
      if (!item || item.ruleId !== 'loan_general' || relations.memberOwner[item.contractId]) return;
      var contractId = text(item.contractId); if (!contractId) return;
      var fieldSetId = text(item.fieldSetId) || '__legacy__';
      if (!grouped[contractId]) grouped[contractId] = {};
      if (!grouped[contractId][fieldSetId]) grouped[contractId][fieldSetId] = { items: [], latestAt: 0, latestIndex: index };
      var group = grouped[contractId][fieldSetId]; group.items.push(item); group.latestIndex = Math.max(group.latestIndex, index);
      var extractedAt = Date.parse(item.extractAt || ''); if (isFinite(extractedAt)) group.latestAt = Math.max(group.latestAt, extractedAt);
    });
    var selected = [];
    Object.keys(grouped).forEach(function (contractId) {
      var groups = Object.keys(grouped[contractId]).map(function (key) { return grouped[contractId][key]; });
      groups.sort(function (left, right) { return (right.latestAt - left.latestAt) || (right.latestIndex - left.latestIndex); });
      if (groups.length) selected = selected.concat(groups[0].items);
    });
    return selected;
  }
  function buildModel(context) {
    context = context || {};
    var project = context.project || {};
    var contracts = list(context.contracts);
    var results = list(context.results);
    var relations = relationIndex(context);
    var contractMap = {};
    contracts.forEach(function (contract) { if (contract && contract.id) contractMap[contract.id] = contract; });
    var reportDate = parseDate(project.loanReportDate || project.reportDate || project.date);
    var validations = [];
    if (!reportDate) addValidation(validations, 'error', 'report_date_missing', '请先明确项目报告日，才能判断本年及报表列报。');
    var covenantByOwner = {};
    results.filter(function (item) { return item && item.ruleId === 'loan_covenant'; }).forEach(function (item) {
      var owner = relations.memberOwner[item.contractId] || item.contractId;
      if (!covenantByOwner[owner]) covenantByOwner[owner] = [];
      covenantByOwner[owner].push(item);
    });
    var loanResults = latestLoanResults(results, relations);
    var debtCounters = {};
    var debts = loanResults.map(function (item, index) {
      var contract = contractMap[item.contractId] || {};
      debtCounters[item.contractId] = (debtCounters[item.contractId] || 0) + 1;
      var amount = parseAmount(firstValue(item, ['contract_principal', 'principal_amount', 'loan_amount', 'amount']), item.currency);
      var currency = amount.currency || normalizeCurrency(item.currency);
      var debt = {
        id: text(item.id) || (text(item.contractId) + ':debt:' + debtCounters[item.contractId]),
        sourceIndex: index, sourceResultId: text(item.id), contractId: text(item.contractId),
        contractName: text(contract.file || contract.name || item.source_document) || '未命名借款文件',
        contractNo: text(item.contract_no) || '未明确', borrower: text(item.borrower) || '未明确', lender: text(item.lender) || '未明确',
        currency: currency || '未明确', principal: amount.valid ? amount.amount : null,
        principalText: text(firstValue(item, ['contract_principal', 'principal_amount', 'loan_amount', 'amount'])) || '未明确',
        signingDate: parseDate(item.signing_date), startDate: parseDate(item.loan_start_date), maturityDate: parseDate(item.maturity_date),
        newSigned: false, newEffective: false, computedStatementClassification: '待结合报告日判断',
        risks: [], repayment: null, raw: item, validations: [], relatedFiles: []
      };
      debt.displayName = (known(debt.lender) ? debt.lender + '-' : '') + (known(debt.contractNo) ? debt.contractNo : debt.contractName);
      var group = relations.groupsByAnchor[debt.contractId];
      debt.relatedFiles = list(group && group.members).map(function (member) {
        var relatedContract = contractMap[member.fileId] || {};
        return { fileId: member.fileId, role: member.role || '关联资料', name: relatedContract.file || relatedContract.name || member.fileId };
      });
      if (reportDate) {
        var reportYear = reportDate.date.getUTCFullYear();
        debt.newSigned = !!debt.signingDate && debt.signingDate.date.getUTCFullYear() === reportYear && debt.signingDate.date <= reportDate.date;
        debt.newEffective = !!debt.startDate && debt.startDate.date.getUTCFullYear() === reportYear && debt.startDate.date <= reportDate.date;
        if (debt.signingDate && debt.signingDate.date > reportDate.date) {
          addValidation(debt.validations, 'warning', 'signed_after_report_date', '合同签订日晚于报告日，应作为期后合同或复核日期准确性。', debt);
        }
        if (debt.startDate && debt.startDate.date > reportDate.date) {
          addValidation(debt.validations, 'warning', 'effective_after_report_date', '借款起始日晚于报告日，不应计入报告日存续借款。', debt);
        }
        if (debt.maturityDate) {
          var remainingDays = Math.ceil((debt.maturityDate.date - reportDate.date) / 86400000);
          debt.computedStatementClassification = remainingDays < 0 ? '报告日前已到期，待核实' : (remainingDays <= 365 ? '流动负债（辅助测算）' : '非流动负债（辅助测算）');
          if (remainingDays < 0) addValidation(debt.validations, 'warning', 'past_due', '报告日已超过合同到期日，请核实续期、偿还或逾期状态。', debt);
        }
      }
      if (!currency) addValidation(debt.validations, 'warning', 'currency_missing', '借款币种未明确，金额不纳入分币种汇总。', debt);
      if (!amount.valid) addValidation(debt.validations, 'warning', 'principal_invalid', '合同借款金额无法可靠解析。', debt);
      if (normalizeCurrency(item.currency) && amount.currency && normalizeCurrency(item.currency) !== amount.currency) {
        addValidation(debt.validations, 'error', 'currency_conflict', '币种字段与金额文本中的币种不一致。', debt);
      }
      if (debt.startDate && debt.maturityDate && debt.startDate.date > debt.maturityDate.date) {
        addValidation(debt.validations, 'error', 'date_conflict', '借款起始日晚于到期日。', debt);
      }
      debt.repayment = buildRepayment(debt, debt.validations);
      var knownRepaymentTotal = debt.repayment.rows.reduce(function (sum, row) { return sum + (row.amount === null ? 0 : row.amount); }, 0);
      if (debt.principal !== null && knownRepaymentTotal > debt.principal * 1.001) {
        addValidation(debt.validations, 'error', 'repayment_exceeds_principal', '已解析本金还款金额合计超过合同本金，请检查重复计划、金额单位或补充协议覆盖关系。', debt);
      }
      debt.repayment.rows.forEach(function (row) {
        var dueDate = parseDate(row.date);
        if (dueDate && debt.startDate && dueDate.date < debt.startDate.date) addValidation(debt.validations, 'warning', 'repayment_before_start', '存在早于借款起始日的还款日期：' + row.date, debt);
        if (dueDate && debt.maturityDate && dueDate.date > debt.maturityDate.date) addValidation(debt.validations, 'warning', 'repayment_after_maturity', '存在晚于合同到期日的还款日期：' + row.date, debt);
      });
      debt.risks = riskItems(debt, covenantByOwner[debt.contractId] || [], reportDate);
      validations = validations.concat(debt.validations);
      return debt;
    });
    if (!debts.length) addValidation(validations, 'warning', 'no_loan_results', '当前项目没有可用于借款审计的主文件提取结果。');
    var currencyTotals = {}; var currencyCounts = {};
    debts.forEach(function (debt) {
      if (debt.principal === null || debt.currency === '未明确') return;
      currencyTotals[debt.currency] = (currencyTotals[debt.currency] || 0) + debt.principal;
      currencyCounts[debt.currency] = (currencyCounts[debt.currency] || 0) + 1;
    });
    var currencyStats = Object.keys(currencyTotals).sort().map(function (currency) {
      return { currency: currency, currencyName: CURRENCY_NAMES[currency] || currency, amount: currencyTotals[currency], debtCount: currencyCounts[currency], display: formatAmount(currencyTotals[currency], currency) };
    });
    var excludedContracts = contracts.filter(function (contract) { return contract && relations.memberOwner[contract.id]; }).map(function (contract) {
      var member = relations.memberInfo[contract.id] || {};
      return { id: contract.id, name: contract.file || contract.name || contract.id, role: member.role || '关联资料', anchorFileId: relations.memberOwner[contract.id] };
    });
    var risks = [];
    debts.forEach(function (debt) { debt.risks.forEach(function (risk) { risks.push({ debtId: debt.id, contractId: debt.contractId, contractNo: debt.contractNo, type: risk.type, label: risk.label, severity: risk.severity, detail: risk.detail }); }); });
    var repaymentPlan = [];
    debts.forEach(function (debt) { repaymentPlan = repaymentPlan.concat(debt.repayment.rows); });
    var reportYearValue = reportDate ? reportDate.date.getUTCFullYear() : null;
    var monthlyMatrix = buildMonthlyMatrix(debts, reportYearValue);
    var futureTwelveMonthTotals = {}; var futureTwelveMonthDebtIds = {}; var maturityWithinTwelveDebtIds = {};
    var futureCutoff = reportDate ? addMonths(reportDate.date, 12) : null;
    if (reportDate && futureCutoff) {
      repaymentPlan.forEach(function (row) {
        var due = parseDate(row.date);
        if (!due || due.date <= reportDate.date || due.date > futureCutoff) return;
        futureTwelveMonthDebtIds[row.debtId] = true;
        if (row.amount !== null) {
          var dueCurrency = row.currency || '未明确';
          futureTwelveMonthTotals[dueCurrency] = (futureTwelveMonthTotals[dueCurrency] || 0) + row.amount;
        }
      });
      debts.forEach(function (debt) {
        if (debt.maturityDate && debt.maturityDate.date > reportDate.date && debt.maturityDate.date <= futureCutoff) maturityWithinTwelveDebtIds[debt.id] = true;
      });
    }
    var contractIds = {};
    debts.forEach(function (debt) { contractIds[debt.contractId] = true; });
    var loanCandidateIds = {};
    contracts.forEach(function (contract) {
      if (!contract || relations.memberOwner[contract.id]) return;
      if (contract.ruleId === 'loan_general' || contract.detectedRuleId === 'loan_general' || contractIds[contract.id]) loanCandidateIds[contract.id] = true;
    });
    var loanCandidateCount = Object.keys(loanCandidateIds).length;
    var extractedLoanFileCount = Object.keys(contractIds).length;
    var counts = {
      debtCount: debts.length, contractCount: Object.keys(contractIds).length, associatedExcluded: excludedContracts.length,
      loanCandidateFileCount: loanCandidateCount, extractedLoanFileCount: extractedLoanFileCount,
      extractionCoverage: loanCandidateCount ? Math.round(extractedLoanFileCount / loanCandidateCount * 100) : 0,
      newSigned: debts.filter(function (debt) { return debt.newSigned; }).length,
      newEffective: debts.filter(function (debt) { return debt.newEffective; }).length,
      riskCount: risks.length, pendingRepayment: debts.filter(function (debt) { return debt.repayment.status !== '已解析'; }).length,
      futureTwelveMonthDebtCount: Object.keys(futureTwelveMonthDebtIds).length,
      maturityWithinTwelveCount: Object.keys(maturityWithinTwelveDebtIds).length,
      floatingRateCount: debts.filter(function (debt) { return debt.risks.some(function (risk) { return risk.type === 'floating_rate'; }); }).length,
      securedCount: debts.filter(function (debt) { return debt.risks.some(function (risk) { return risk.type === 'security'; }); }).length,
      restrictionCount: debts.filter(function (debt) { return debt.risks.some(function (risk) { return ['covenant', 'financial_covenant', 'prepayment', 'acceleration'].indexOf(risk.type) >= 0; }); }).length,
      rateResetSoonCount: debts.filter(function (debt) { return debt.risks.some(function (risk) { return risk.type === 'rate_reset_soon'; }); }).length
    };
    return {
      project: project, reportDate: reportDate ? reportDate.iso : '', reportYear: reportYearValue,
      debts: debts, counts: counts, summary: counts, currencyTotals: currencyTotals, totalsByCurrency: currencyTotals,
      currencyStats: currencyStats, futureTwelveMonthTotals: futureTwelveMonthTotals, risks: risks, repaymentPlan: repaymentPlan, monthlyMatrix: monthlyMatrix,
      validations: validations, validationHints: validations, excludedContracts: excludedContracts
    };
  }

  function badge(label, tone) {
    var tones = { green: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30', amber: 'bg-amber-500/10 text-amber-300 border-amber-500/30', red: 'bg-red-500/10 text-red-300 border-red-500/30', blue: 'bg-blue-500/10 text-blue-300 border-blue-500/30', gray: 'bg-gray-800 text-gray-400 border-gray-700' };
    return '<span class="inline-flex items-center px-2 py-0.5 rounded border text-xs ' + (tones[tone] || tones.gray) + '">' + escapeHtml(label) + '</span>';
  }
  function tabButton(view, label, count) {
    var active = state.view === view;
    return '<button type="button" onclick="loanAuditSetView(' + attr(jsArg(view)) + ')" class="px-4 py-2 rounded-lg text-sm border transition-colors ' +
      (active ? 'bg-ey/10 border-ey text-ey' : 'border-gray-800 text-gray-500 hover:text-white hover:border-gray-700') + '">' + escapeHtml(label) + (count === undefined ? '' : ' · ' + count) + '</button>';
  }
  function emptyBlock(message) { return '<div class="card p-8 text-center text-sm text-gray-600">' + escapeHtml(message) + '</div>'; }
  function renderDashboard(model) {
    var statCards = [
      ['独立债项', model.counts.debtCount, 'text-white'], ['提取覆盖率', model.counts.extractionCoverage + '%', 'text-blue-300'], ['本年新签', model.counts.newSigned, 'text-emerald-300'],
      ['未来12个月有还款', model.counts.futureTwelveMonthDebtCount, 'text-red-300'], ['未来12个月整笔到期', model.counts.maturityWithinTwelveCount, 'text-red-300'],
      ['浮动利率', model.counts.floatingRateCount, 'text-blue-300'], ['存在担保', model.counts.securedCount, 'text-blue-300'],
      ['存在限制条款', model.counts.restrictionCount, 'text-amber-300'], ['利率调整临近', model.counts.rateResetSoonCount, 'text-amber-300'],
      ['还款待明确', model.counts.pendingRepayment, 'text-red-300']
    ];
    var stats = '<div class="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">' + statCards.map(function (entry) {
      return '<div class="card p-4"><p class="text-xs text-gray-600">' + entry[0] + '</p><p class="text-2xl font-bold mt-1 ' + entry[2] + '">' + entry[1] + '</p></div>';
    }).join('') + '</div>';
    var currencies = model.currencyStats.length ? model.currencyStats.map(function (entry) {
      var futureAmount = model.futureTwelveMonthTotals[entry.currency];
      return '<div class="border border-gray-800 rounded-lg p-3"><div class="flex justify-between gap-3"><span class="text-sm text-gray-400">' + escapeHtml(entry.currencyName) + ' (' + entry.currency + ')</span>' + badge(entry.debtCount + '笔', 'gray') + '</div><p class="text-lg font-semibold text-white mt-2">' + escapeHtml(entry.display) + '</p><p class="text-xs text-gray-600 mt-1">未来12个月合同约定还本：' + escapeHtml(futureAmount === undefined ? '暂无明确金额' : formatAmount(futureAmount, entry.currency)) + '</p></div>';
    }).join('') : '<p class="text-sm text-gray-600">暂无可汇总的币种金额。</p>';
    var risks = model.risks.length ? model.risks.map(function (risk) {
      return '<div class="border-l-2 ' + (risk.severity === 'high' ? 'border-red-500' : 'border-amber-500') + ' pl-3 py-1"><div class="flex flex-wrap gap-2 items-center">' + badge(risk.label, risk.severity === 'high' ? 'red' : 'amber') + '<span class="text-xs text-gray-500">' + escapeHtml(risk.contractNo) + '</span></div><p class="text-sm text-gray-400 mt-1">' + escapeHtml(risk.detail || '请结合合同原文复核') + '</p></div>';
    }).join('') : '<p class="text-sm text-gray-600">未识别到浮动利率、担保或限制性条款风险。</p>';
    var validations = model.validations.length ? model.validations.map(function (item) {
      return '<li class="flex gap-2 text-sm"><span class="' + (item.level === 'error' ? 'text-red-400' : 'text-amber-400') + '">•</span><span class="text-gray-400">' + escapeHtml(item.message) + '</span></li>';
    }).join('') : '<li class="text-sm text-emerald-400">未发现结构化校验异常。</li>';
    return stats + '<p class="text-xs text-gray-600">借款主文件提取进度：' + model.counts.extractedLoanFileCount + '/' + model.counts.loanCandidateFileCount + '；汇总结果仅覆盖已完成“借款·通用条款”提取的主文件。</p><div class="grid lg:grid-cols-2 gap-4"><section class="card p-5"><h2 class="font-semibold text-white mb-3">分币种合同金额</h2><div class="space-y-2">' + currencies + '</div><p class="text-xs text-gray-600 mt-3">不同币种保持独立统计，不进行汇率折算；金额为合同约定金额，不代表报告日实际借款余额。</p></section><section class="card p-5"><h2 class="font-semibold text-white mb-3">重点风险</h2><div class="space-y-4">' + risks + '</div></section></div><section class="card p-5"><div class="flex justify-between gap-3"><h2 class="font-semibold text-white">校验提示</h2>' + badge(model.counts.associatedExcluded + '份关联子文件已排除', 'blue') + '</div><ul class="space-y-2 mt-3">' + validations + '</ul></section>';
  }
  function field(label, value) { return '<div><p class="text-xs text-gray-600">' + escapeHtml(label) + '</p><p class="text-sm text-gray-300 mt-1 break-words">' + escapeHtml(known(value) ? value : '未明确') + '</p></div>'; }
  function auditSuggestions(debt) {
    var suggestions = ['余额函证'];
    if (debt.risks.some(function (risk) { return risk.type === 'floating_rate' || risk.type === 'rate_reset_soon'; })) suggestions.push('利率重新计算');
    if (debt.repayment.rows.length || debt.repayment.pendingReason) suggestions.push('还款计划及流动性分类核对');
    if (debt.risks.some(function (risk) { return risk.type === 'security'; })) suggestions.push('担保文件及权利状态核对');
    if (debt.risks.some(function (risk) { return risk.type === 'covenant' || risk.type === 'financial_covenant' || risk.type === 'acceleration'; })) suggestions.push('限制性契约合规测试');
    return suggestions;
  }
  function renderCards(model) {
    if (!model.debts.length) return emptyBlock('暂无借款主文件提取结果。');
    return '<div class="space-y-3">' + model.debts.map(function (debt) {
      var expanded = !!state.expandedCards[debt.id];
      var tags = [];
      if (debt.newSigned) tags.push(badge('本年新签', 'green'));
      if (debt.newEffective) tags.push(badge('本年生效', 'green'));
      debt.risks.forEach(function (risk) { tags.push(badge(risk.label, risk.severity === 'high' ? 'red' : 'amber')); });
      if (!tags.length) tags.push(badge('常规复核', 'gray'));
      var suggestions = auditSuggestions(debt).map(function (item) { return '<span class="text-sm text-gray-300">□ ' + escapeHtml(item) + '</span>'; }).join('');
      var details = expanded ? '<div class="border-t border-gray-800 px-5 py-4 space-y-5">' +
        '<section><h4 class="text-sm font-semibold text-white mb-3">基本信息</h4><div class="grid md:grid-cols-2 xl:grid-cols-4 gap-4">' + field('借款人', debt.borrower) + field('贷款人', debt.lender) + field('签约日', debt.signingDate && debt.signingDate.iso) + field('借款起始日', debt.startDate && debt.startDate.iso) + field('到期日', debt.maturityDate && debt.maturityDate.iso) + field('报告日列报辅助测算', debt.computedStatementClassification) + field('借款用途', debt.raw.loan_purpose) + field('关联资料', debt.relatedFiles.map(function (item) { return item.name + '（' + item.role + '）'; }).join('；') || '无') + '</div></section>' +
        '<section><h4 class="text-sm font-semibold text-white mb-3">利率信息</h4><div class="grid md:grid-cols-2 xl:grid-cols-4 gap-4">' + field('利率类型', debt.raw.interest_rate_type) + field('执行利率', debt.raw.interest_rate) + field('调整频率', debt.raw.interest_rate_adjustment_frequency) + field('下次调整日', debt.raw.next_interest_rate_adjustment_date) + field('计息及结息方式', debt.raw.interest_method) + '</div></section>' +
        '<section><h4 class="text-sm font-semibold text-white mb-3">还款安排</h4><div class="grid md:grid-cols-2 gap-4">' + field('还本方式', debt.raw.repayment_method) + field('本金还款计划', debt.raw.repayment_schedule) + '</div></section>' +
        '<section><h4 class="text-sm font-semibold text-white mb-3">担保情况</h4><div class="grid md:grid-cols-3 gap-4">' + field('借款性质', debt.raw.loan_nature) + field('保证人', debt.raw.guarantor) + field('抵质押及担保范围', debt.raw.security_summary) + '</div></section>' +
        '<section><h4 class="text-sm font-semibold text-white mb-3">关键条款识别</h4><div class="grid md:grid-cols-3 gap-4">' + field('提前还款限制', debt.raw.prepayment_restriction_status) + field('财务指标约束', debt.raw.financial_covenant_status) + field('加速到期/重大违约触发', debt.raw.acceleration_or_material_default_trigger_status) + '</div><div class="grid md:grid-cols-2 gap-4 mt-4">' + field('提前还款及违约条款', debt.raw.prepayment_default) + field('限制性契约', debt.raw.covenant_summary) + '</div></section>' +
        '<section><h4 class="text-sm font-semibold text-ey mb-3">审计关注事项</h4>' + field('AI判断', debt.raw.auditor_summary) + '<div class="flex flex-wrap gap-x-5 gap-y-2 mt-3">' + suggestions + '</div></section>' +
        '</div>' : '';
      return '<article class="card overflow-hidden"><div class="p-5"><div class="flex flex-wrap justify-between gap-3"><div><div class="flex flex-wrap gap-2 items-center"><h3 class="font-semibold text-white">' + escapeHtml(debt.displayName) + '</h3>' + tags.join('') + '</div><p class="text-xs text-gray-600 mt-1">来源文件：' + escapeHtml(debt.contractName) + '</p></div><div class="text-right"><p class="text-lg font-semibold text-white">' + escapeHtml(formatAmount(debt.principal, debt.currency)) + '</p><p class="text-xs text-gray-600">原文：' + escapeHtml(debt.principalText) + '</p></div></div><div class="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4">' + field('起始日', debt.startDate && debt.startDate.iso) + field('到期日', debt.maturityDate && debt.maturityDate.iso) + field('还款计划', debt.repayment.status) + field('风险数', debt.risks.length + '项') + '</div><div class="flex flex-wrap justify-end gap-2 mt-4"><button type="button" onclick="loanAuditOpenWorkpaper(' + attr(jsArg(debt.contractId)) + ')" class="btn-outline btn-sm px-3 py-1.5 rounded-lg text-xs">跳转底稿</button><button type="button" onclick="loanAuditToggleCard(' + attr(jsArg(debt.id)) + ')" class="btn-outline btn-sm px-3 py-1.5 rounded-lg text-xs">' + (expanded ? '收起' : '展开') + '</button></div></div>' + details + '</article>';
    }).join('') + '</div>';
  }
  function renderRepayment(model) {
    var plan = model.repaymentPlan.length ? '<details class="card overflow-hidden"><summary class="px-4 py-3 text-sm text-gray-400 cursor-pointer">查看逐笔还款明细（' + model.repaymentPlan.length + '笔）</summary><div class="overflow-x-auto border-t border-gray-800"><table class="w-full text-sm"><thead><tr class="border-b border-gray-800 text-left text-gray-500"><th class="p-3">合同编号</th><th class="p-3">还款日</th><th class="p-3">币种</th><th class="p-3 text-right">本金金额</th><th class="p-3">解析口径</th><th class="p-3">状态</th></tr></thead><tbody>' + model.repaymentPlan.map(function (row) {
      return '<tr class="border-b border-gray-900"><td class="p-3 text-gray-300">' + escapeHtml(row.contractNo) + '</td><td class="p-3 text-white">' + escapeHtml(row.date) + '</td><td class="p-3 text-gray-400">' + escapeHtml(row.currency || '未明确') + '</td><td class="p-3 text-right text-gray-300">' + escapeHtml(row.amount === null ? row.amountText : formatAmount(row.amount, row.currency)) + '</td><td class="p-3 text-gray-500">' + escapeHtml(row.source) + '</td><td class="p-3">' + badge(row.status, row.amount === null ? 'amber' : 'green') + '</td></tr>';
    }).join('') + '</tbody></table></div></details>' : emptyBlock('还款日期均待明确，未生成计划行。');
    var months = model.monthlyMatrix.months;
    var currencies = [];
    model.debts.forEach(function (debt) { if (currencies.indexOf(debt.currency) < 0) currencies.push(debt.currency); });
    var matrix = months.length ? currencies.map(function (currency) {
      var currencyDebts = model.debts.filter(function (debt) { return debt.currency === currency; });
      if (!currencyDebts.length) return '';
      var head = currencyDebts.map(function (debt) { return '<th class="p-2 text-right whitespace-nowrap min-w-[150px]" title="' + attr(debt.contractName) + '">' + escapeHtml(debt.displayName) + '</th>'; }).join('');
      var body = months.map(function (month) {
        var cells = currencyDebts.map(function (debt) {
          var matrixRow = model.monthlyMatrix.rowByDebtId[debt.id]; var cell = matrixRow && matrixRow.cells[month];
          if (!cell) return '<td class="p-2 text-right text-gray-800">—</td>';
          var value = cell.amount === null ? '待明确' : Number(cell.amount).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
          if (cell.hasUncertain && cell.amount !== null) value += ' + 待明确';
          return '<td class="p-2 text-right ' + (cell.hasUncertain ? 'text-amber-300' : 'text-gray-300') + '">' + escapeHtml(value) + '</td>';
        }).join('');
        var total = model.monthlyMatrix.totalsByCurrency[currency] && model.monthlyMatrix.totalsByCurrency[currency][month];
        return '<tr class="border-b border-gray-900"><td class="p-2 text-gray-300 sticky left-0 bg-gray-950 whitespace-nowrap">' + escapeHtml(month.replace('-', '年') + '月') + '</td>' + cells + '<td class="p-2 text-right font-semibold text-white">' + escapeHtml(total === undefined ? '—' : Number(total).toLocaleString('zh-CN', { maximumFractionDigits: 2 })) + '</td></tr>';
      }).join('');
      return '<div class="card p-4 overflow-x-auto"><div class="flex items-center justify-between gap-3 mb-3"><h2 class="font-semibold text-white">按月还本矩阵 · ' + escapeHtml(CURRENCY_NAMES[currency] || currency) + '</h2>' + badge(currencyDebts.length + '笔债项', 'blue') + '</div><table class="text-xs min-w-full"><thead><tr class="text-gray-500 border-b border-gray-800"><th class="p-2 text-left sticky left-0 bg-gray-950">还款月份</th>' + head + '<th class="p-2 text-right whitespace-nowrap min-w-[120px]">当月合计</th></tr></thead><tbody>' + body + '</tbody></table><p class="text-xs text-gray-600 mt-3">行按月份列示，列为独立债项；不同币种分表。“每季度末”只落入3、6、9、12月，绝不平均分摊到季度内各月。</p></div>';
    }).join('') : '';
    var pending = model.debts.filter(function (debt) { return debt.repayment.pendingReason; });
    var pendingHtml = pending.length ? '<div class="card p-4"><h2 class="font-semibold text-white mb-3">待明确事项</h2><ul class="space-y-2">' + pending.map(function (debt) { return '<li class="text-sm text-amber-300">' + escapeHtml(debt.contractNo + '：' + debt.repayment.pendingReason) + '</li>'; }).join('') + '</ul></div>' : '';
    return '<div class="space-y-4">' + plan + matrix + pendingHtml + '</div>';
  }
  function renderPage(context) {
    var model = buildModel(context);
    if (['dashboard', 'cards', 'repayment'].indexOf(state.view) < 0) state.view = 'dashboard';
    var content = state.view === 'cards' ? renderCards(model) : (state.view === 'repayment' ? renderRepayment(model) : renderDashboard(model));
    var project = context && context.project || {};
    return '<div class="space-y-5"><div class="flex flex-wrap justify-between items-start gap-4"><div><button type="button" onclick="loanAuditGoBack()" class="text-sm text-gray-500 hover:text-ey">返回项目</button><h1 class="text-2xl font-bold text-white mt-1">借款审计中心</h1><p class="text-sm text-gray-600">' + escapeHtml(project.name || '当前项目') + ' · 主文件形成债项，关联子文件仅作支持资料</p></div><div class="flex flex-wrap items-end gap-2"><label class="text-xs text-gray-500">项目报告日<input type="date" value="' + escapeHtml(model.reportDate) + '" onchange="loanAuditSetReportDate(this.value)" class="block mt-1 bg-black border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"></label><button type="button" onclick="loanAuditExport()" class="btn btn-sm px-4 py-2">导出借款审计Excel</button></div></div><div class="flex flex-wrap gap-2">' + tabButton('dashboard', '驾驶舱') + tabButton('cards', '合同卡片', model.counts.debtCount) + tabButton('repayment', '还款计划', model.repaymentPlan.length) + '</div>' + content + '</div>';
  }

  function resolveXlsx() {
    if (global && global.XLSX) return global.XLSX;
    if (typeof require === 'function') {
      try { return require('xlsx-js-style'); } catch (firstError) {
        try { return require('xlsx'); } catch (secondError) { return null; }
      }
    }
    return null;
  }
  function styleSheet(XLSX, sheet) {
    if (!sheet || !sheet['!ref']) return sheet;
    var range = XLSX.utils.decode_range(sheet['!ref']); var columns = [];
    for (var column = range.s.c; column <= range.e.c; column++) {
      var max = 10;
      for (var row = range.s.r; row <= range.e.r; row++) {
        var cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })];
        if (cell && cell.v !== undefined) max = Math.max(max, Math.min(45, String(cell.v).length + 2));
        if (cell) {
          cell.s = cell.s || {};
          cell.s.alignment = { vertical: 'center', wrapText: true };
          if (row === range.s.r) cell.s = { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { patternType: 'solid', fgColor: { rgb: '1F4E78' } }, alignment: { vertical: 'center', wrapText: true } };
        }
      }
      columns.push({ wch: max });
    }
    sheet['!cols'] = columns; sheet['!freeze'] = { xSplit: 0, ySplit: 1 };
    return sheet;
  }
  function exportExcel(context) {
    var XLSX = resolveXlsx();
    if (!XLSX) {
      var missingError = new Error('Excel 导出组件未加载');
      if (global && typeof global.alert === 'function') global.alert(missingError.message);
      throw missingError;
    }
    var model = buildModel(context || {}); var workbook = XLSX.utils.book_new();
    var debtRows = model.debts.map(function (debt) {
      return {
        '主文件': debt.contractName, '合同编号': debt.contractNo, '借款人': debt.borrower, '贷款人': debt.lender,
        '币种': debt.currency, '合同本金': debt.principal, '金额原文': debt.principalText,
        '签约日': debt.signingDate ? debt.signingDate.iso : '', '本年新签': debt.newSigned ? '是' : '否',
        '起始日': debt.startDate ? debt.startDate.iso : '', '本年生效': debt.newEffective ? '是' : '否',
        '到期日': debt.maturityDate ? debt.maturityDate.iso : '', '报告日列报测算': debt.computedStatementClassification,
        '利率类型': text(debt.raw.interest_rate_type), '执行利率': text(debt.raw.interest_rate),
        '利率调整频率': text(debt.raw.interest_rate_adjustment_frequency), '下次利率调整日': text(debt.raw.next_interest_rate_adjustment_date),
        '还本方式': text(debt.raw.repayment_method), '本金还款计划': text(debt.raw.repayment_schedule),
        '借款性质': text(debt.raw.loan_nature), '保证人': text(debt.raw.guarantor), '担保摘要': text(debt.raw.security_summary),
        '提前还款限制状态': text(debt.raw.prepayment_restriction_status), '财务指标约束状态': text(debt.raw.financial_covenant_status),
        '加速到期/重大违约触发状态': text(debt.raw.acceleration_or_material_default_trigger_status),
        '限制性契约': text(debt.raw.covenant_summary), '风险标签': debt.risks.map(function (risk) { return risk.label; }).join('；'),
        '关联资料': debt.relatedFiles.map(function (file) { return file.name + '（' + file.role + '）'; }).join('；'),
        '审计提示': text(debt.raw.auditor_summary)
      };
    });
    var currencyRows = model.currencyStats.map(function (entry) { return { '币种代码': entry.currency, '币种': entry.currencyName, '债项数': entry.debtCount, '合同金额合计': entry.amount, '未来12个月合同约定还本': model.futureTwelveMonthTotals[entry.currency] === undefined ? '' : model.futureTwelveMonthTotals[entry.currency] }; });
    var repaymentRows = model.repaymentPlan.map(function (row) { return { '合同编号': row.contractNo, '还款日': row.date, '币种': row.currency, '本金金额': row.amount, '金额说明': row.amountText, '解析口径': row.source, '状态': row.status }; });
    var validationRows = model.validations.map(function (item) { return { '级别': item.level === 'error' ? '错误' : '提示', '代码': item.code, '合同/债项': item.debtId, '校验提示': item.message }; });
    var dashboardRows = [
      { '指标': '报告日', '结果': model.reportDate },
      { '指标': '独立债项数', '结果': model.counts.debtCount },
      { '指标': '主合同文件数', '结果': model.counts.contractCount },
      { '指标': '本年新签', '结果': model.counts.newSigned },
      { '指标': '本年生效', '结果': model.counts.newEffective },
      { '指标': '未来12个月有还款的债项', '结果': model.counts.futureTwelveMonthDebtCount },
      { '指标': '未来12个月整笔到期债项', '结果': model.counts.maturityWithinTwelveCount },
      { '指标': '浮动利率债项', '结果': model.counts.floatingRateCount },
      { '指标': '存在担保债项', '结果': model.counts.securedCount },
      { '指标': '存在限制条款债项', '结果': model.counts.restrictionCount },
      { '指标': '利率调整日临近债项', '结果': model.counts.rateResetSoonCount },
      { '指标': '还款计划待明确债项', '结果': model.counts.pendingRepayment }
    ];
    [
      ['驾驶舱', dashboardRows], ['借款清单', debtRows], ['分币种汇总', currencyRows], ['还款明细', repaymentRows], ['校验提示', validationRows]
    ].forEach(function (entry) {
      var rows = entry[1].length ? entry[1] : [{ '说明': '暂无数据' }];
      XLSX.utils.book_append_sheet(workbook, styleSheet(XLSX, XLSX.utils.json_to_sheet(rows)), entry[0]);
    });
    var matrixCurrencies = [];
    model.debts.forEach(function (debt) { if (matrixCurrencies.indexOf(debt.currency) < 0) matrixCurrencies.push(debt.currency); });
    matrixCurrencies.sort().forEach(function (currency) {
      var currencyDebts = model.debts.filter(function (debt) { return debt.currency === currency; });
      var matrixRows = model.monthlyMatrix.months.map(function (month) {
        var row = { '还款月份': month };
        currencyDebts.forEach(function (debt) {
          var matrixRow = model.monthlyMatrix.rowByDebtId[debt.id]; var cell = matrixRow && matrixRow.cells[month];
          row[debt.displayName] = !cell ? '' : (cell.amount === null ? '待明确' : cell.amount);
        });
        var monthTotal = model.monthlyMatrix.totalsByCurrency[currency] && model.monthlyMatrix.totalsByCurrency[currency][month];
        row['当月合计'] = monthTotal === undefined ? '' : monthTotal;
        return row;
      });
      XLSX.utils.book_append_sheet(workbook, styleSheet(XLSX, XLSX.utils.json_to_sheet(matrixRows.length ? matrixRows : [{ '说明': '暂无明确还款计划' }])), ('还款计划-' + currency).substring(0, 31));
    });
    var naming = global && global.ExportNaming;
    var projectName = text(model.project.name || model.project.client || '借款审计').replace(/[\\/:*?"<>|]/g, '_').substring(0, 50);
    var localDate = new Date();
    var stamp = String(localDate.getFullYear()) + String(localDate.getMonth() + 1).padStart(2, '0') + String(localDate.getDate()).padStart(2, '0');
    var fileName = naming ? naming.defaultExportName({ projectName: projectName, clientName: model.project.client, typeLabel: '借款审计底稿' }) : projectName + '_借款审计底稿_' + stamp + '.xlsx';
    if (global && typeof global.requestExcelFileName === 'function') {
      global.requestExcelFileName(fileName, function (finalName) {
        try { XLSX.writeFile(workbook, finalName); }
        catch (error) { if (global && typeof global.alert === 'function') global.alert('借款审计底稿导出失败：' + error.message); }
      });
      return { workbook: workbook, fileName: fileName, model: model, pending: true };
    }
    XLSX.writeFile(workbook, fileName);
    return { workbook: workbook, fileName: fileName, model: model };
  }
  function currentContext() {
    return global && typeof global.getLoanAuditContext === 'function' ? global.getLoanAuditContext() : null;
  }
  function rerender() { if (global && typeof global.render === 'function') global.render(); }
  function setView(view) { if (['dashboard', 'cards', 'repayment'].indexOf(view) >= 0) state.view = view; rerender(); return state.view; }
  function setReportDate(value) {
    var context = currentContext();
    if (!context || !context.project) return false;
    context.project.loanReportDate = text(value);
    context.project.updatedAt = new Date().toISOString();
    if (global && typeof global.save === 'function') global.save();
    rerender(); return true;
  }
  function toggleCard(debtId) { state.expandedCards[debtId] = !state.expandedCards[debtId]; rerender(); return state.expandedCards[debtId]; }
  function openWorkpaper(contractId) { if (global && typeof global.nav === 'function') global.nav('work', { cid: contractId, ruleId: 'loan_general' }); }
  function goBack() {
    var context = currentContext(); var projectId = context && context.project && context.project.id;
    if (global && typeof global.nav === 'function') global.nav('proj', projectId ? { pid: projectId } : undefined);
  }
  function exportCurrent() { var context = currentContext(); if (context) return exportExcel(context); return null; }

  global.loanAuditSetView = setView;
  global.loanAuditView = setView;
  global.loanAuditSetReportDate = setReportDate;
  global.loanAuditToggleCard = toggleCard;
  global.loanAuditOpenWorkpaper = openWorkpaper;
  global.loanAuditGoBack = goBack;
  global.loanAuditExport = exportCurrent;

  return {
    buildModel: buildModel,
    renderPage: renderPage,
    exportExcel: exportExcel,
    parseAmount: parseAmount,
    parseDate: parseDate
  };
});
