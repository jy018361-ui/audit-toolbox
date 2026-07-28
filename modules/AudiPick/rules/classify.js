// 文档类型 AI 分类（上传 OCR 后推荐提取模板）
(function (global) {
  function catalogForPrompt() {
    var lines = [];
    RuleEngine.getAllSelectableRules().forEach(function (r) {
      var kind = r.docKind === 'table' ? '表格' : '条款';
      lines.push('- ' + r.id + ' | ' + r.name + ' | ' + kind);
    });
    return lines.join('\n');
  }

  function normalizeConfidence(v) {
    v = String(v || '').toLowerCase();
    if (v === 'high' || v === '高') return 'high';
    if (v === 'medium' || v === '中') return 'medium';
    return 'low';
  }

  function fallbackRule(project) {
    if (project && project.defaultRuleId && RuleEngine.getRule(project.defaultRuleId)) {
      return project.defaultRuleId;
    }
    return RULE_ORDER[0];
  }

  global.classifyDocument = function (text, fileName, project) {
    if (!ok()) {
      return Promise.resolve({
        ruleId: fallbackRule(project),
        docLabel: '',
        confidence: 'low',
        reason: '未配置 AI，使用项目首选或默认模板'
      });
    }
    var sample = String(text || '').substring(0, 12000);
    if (!sample.trim()) {
      return Promise.resolve({
        ruleId: fallbackRule(project),
        docLabel: '',
        confidence: 'low',
        reason: '文档无文本'
      });
    }
    var sysMsg = '你是审计文档分类助手。只能从用户给出的 rule_id 列表中选择 exactly 一项作为 rule_id。只输出 JSON，不要解释。';
    var userMsg = '【文件名】\n' + (fileName || '') +
      '\n\n【可选 rule_id 列表（id | 名称 | 类型）】\n' + catalogForPrompt() +
      '\n\n【文档文本节选】\n' + sample +
      '\n\n【输出格式】\n{"rule_id":"列表中的id","doc_label":"文档类型中文名","confidence":"high或medium或low","reason":"一句话理由"}';

    var body = {
      model: A.m || 'gpt-4',
      messages: [
        { role: 'system', content: sysMsg },
        { role: 'user', content: userMsg }
      ],
      temperature: 0.1,
      max_tokens: 500
    };
    if (!A.think) body.enable_thinking = false;

    var ctrl = new AbortController();
    if (typeof bindTaskAbort === 'function') bindTaskAbort(ctrl);

    return safeFetch(A.u + '/chat/completions?r=' + Date.now(), {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + A.k },
      body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (e) { throw new Error('分类API(' + r.status + ')'); });
      return r.json();
    }).then(function (d) {
      var c = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content || '';
      var m = c.match(/\{[\s\S]*\}/);
      var parsed = {};
      try { parsed = JSON.parse(m ? m[0] : c); } catch (e) { parsed = {}; }
      var rid = parsed.rule_id || parsed.ruleId || '';
      if (!RuleEngine.getRule(rid)) rid = fallbackRule(project);
      return {
        ruleId: rid,
        docLabel: parsed.doc_label || parsed.docLabel || RuleEngine.getRuleName(rid),
        confidence: normalizeConfidence(parsed.confidence),
        reason: parsed.reason || ''
      };
    }).catch(function (err) {
      if (typeof isTaskStoppedErr === 'function' && isTaskStoppedErr(err)) throw err;
      return {
        ruleId: fallbackRule(project),
        docLabel: '',
        confidence: 'low',
        reason: '分类失败: ' + (err.message || '').substring(0, 60)
      };
    });
  };

  global.confirmDocRule = function (contractId, ruleId) {
    var c = gc(contractId);
    if (!c) return;
    if (ruleId) {
      c.ruleId = ruleId;
      activeRuleId = ruleId;
    }
    c.ruleConfirmed = true;
    save();
    render();
  };

  global.classificationBannerHtml = function (contractId) {
    var c = gc(contractId);
    if (!c || !c.detectedRuleId) return '';
    var conf = c.detectedConfidence || 'low';
    var confLabel = conf === 'high' ? '高' : conf === 'medium' ? '中' : '低';
    var confCls = conf === 'high' ? 'text-emerald-400 bg-emerald-900' : conf === 'medium' ? 'text-amber-400 bg-amber-900' : 'text-red-400 bg-red-900';
    var confirmed = c.ruleConfirmed ? '<span class="text-xs text-emerald-400 ml-2">已确认</span>' : '<span class="text-xs text-amber-400 ml-2">待确认后提取</span>';
    return '<div class="card p-3 space-y-2"><div class="flex flex-wrap items-center gap-2">' +
      '<span class="text-xs text-gray-400">AI 识别</span>' +
      '<span class="text-xs px-2 py-0.5 rounded ' + confCls + '">置信度' + confLabel + '</span>' +
      confirmed +
      '</div><p class="text-xs text-gray-500">' + escapeHtml(c.detectedReason || c.docLabel || '') + '</p>' +
      '<div class="flex flex-wrap gap-2 items-center">' +
      '<label class="text-xs text-gray-500">推荐模板</label>' +
      '<select id="docRuleSel_' + contractId + '" onchange="setContractDefaultRule(\'' + contractId + '\',this.value)" class="bg-black border border-gray-700 rounded px-2 py-1 text-xs text-white">' +
      ruleSelectOptionsHtml(getContractRuleId(c)) + '</select>' +
      '<button type="button" onclick="confirmDocRule(\'' + contractId + '\',document.getElementById(\'docRuleSel_' + contractId + '\').value)" class="btn-sec btn-sm text-xs">确认模板</button>' +
      '</div></div>';
  };
})(window);
