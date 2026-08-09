// AudiPick 提取模板 UI 与多模板业务逻辑
(function (global) {
  function ruleTabsHtml(contractId, currentRuleId) {
    var applied = getAppliedRuleIds(contractId);
    var html = '<div class="flex flex-wrap gap-2">';
    RuleEngine.getAllSelectableRules().forEach(function (r) {
      var active = r.id === currentRuleId;
      var cnt = gvRule(contractId, r.id).length;
      var badge = cnt > 0 ? ' ✓' + cnt : '';
      html += '<button type="button" onclick="switchContractRule(\'' + r.id + '\')" class="px-3 py-1.5 rounded-lg text-xs border ' +
        (active ? 'bg-ey text-eydark border-ey font-semibold' : 'bg-gray-900 text-gray-400 border-gray-700 hover:border-gray-500') + '">' +
        escapeHtml(r.shortName || r.name) + badge + '</button>';
    });
    html += '</div>';
    return html;
  }
  global.ruleTabsHtml = ruleTabsHtml;

  function fieldsPreviewHtml(ruleId) {
    var fs = getFields(ruleId);
    return fs.map(function (f) {
      return '<span class="text-xs px-2 py-0.5 rounded bg-gray-800 text-gray-300 mr-1 mb-1 inline-block">' +
        escapeHtml(f.key) + ' → ' + escapeHtml(f.label) + '</span>';
    }).join('') || '<span class="text-xs text-gray-600">未识别到字段</span>';
  }

  function templateKindLabel(r) {
    return r.docKind === 'table' ? '表格型' : '条款型';
  }

  function templateCategoryMatch(r, tab) {
    if (tab === 'all') return true;
    if (tab === 'custom') return false;
    if (tab === 'contract') return ['loan', 'revenue', 'procurement', 'agreement'].indexOf(r.category) >= 0;
    if (tab === 'voucher') return r.category === 'voucher';
    if (tab === 'report') return r.category === 'report';
    return true;
  }

  function getFilteredTemplates() {
    var tab = typeof templateTab !== 'undefined' ? templateTab : 'all';
    var q = (typeof templateSearch !== 'undefined' ? templateSearch : '').trim().toLowerCase();
    var list = [];
    if (tab === 'custom') {
      CUSTOM_RULES.forEach(function (r) { list.push({ id: r.id, rule: r }); });
    } else {
      RULE_ORDER.forEach(function (id) {
        var r = RuleEngine.getRule(id);
        if (!r || !templateCategoryMatch(r, tab)) return;
        list.push({ id: id, rule: r });
      });
    }
    if (q) {
      list = list.filter(function (x) {
        var r = x.rule;
        var blob = [r.name, r.shortName, r.description, r.id].join(' ').toLowerCase();
        return blob.indexOf(q) >= 0;
      });
    }
    return list;
  }

  function templateTabBtn(tab, label, current) {
    var active = current === tab;
    return '<button type="button" onclick="setTemplateTab(\'' + tab + '\')" class="px-4 py-2 rounded-lg text-sm whitespace-nowrap ' +
      (active ? 'bg-ey text-eydark font-semibold' : 'bg-gray-900 text-gray-400 hover:bg-gray-800 hover:text-gray-200 border border-gray-800') + '">' +
      escapeHtml(label) + '</button>';
  }

  function templateCardHtml(item, selectedId) {
    var r = item.rule;
    var active = item.id === selectedId;
    var kind = templateKindLabel(r);
    return '<div role="button" tabindex="0" onclick="viewRule(\'' + item.id + '\')" class="card p-4 cursor-pointer transition-all border-2 ' +
      (active ? 'border-ey bg-[#2a2200]' : 'border-gray-800 hover:border-gray-600 bg-gray-900/50') + '">' +
      '<div class="flex justify-between items-start gap-2">' +
      '<h3 class="font-medium text-white text-sm leading-snug">' + escapeHtml(r.name) + '</h3>' +
      '<span class="text-xs px-2 py-0.5 rounded-full shrink-0 ' + (r.docKind === 'table' ? 'bg-blue-900 text-blue-300' : 'bg-gray-800 text-gray-400') + '">' + kind + '</span>' +
      '</div>' +
      '<p class="text-xs text-gray-500 mt-2 line-clamp-2 leading-relaxed">' + escapeHtml(r.description || '') + '</p>' +
      (active ? '<p class="text-xs text-ey mt-2">已选中 · 详情见右侧</p>' : '') +
      '</div>';
  }

  function getTemplatePresentation(rule) {
    if (!rule) return { useCase: '', example: null };
    var useCase = rule.useCase || rule.description || '';
    var example = rule.example;
    if (!example && rule.baseRuleId) {
      var base = RuleEngine.getRule(rule.baseRuleId);
      if (base) {
        if (!useCase) useCase = base.useCase || base.description || '';
        example = base.example;
      }
    }
    if (!example) {
      example = rule.docKind === 'table'
        ? { category: '明细行', quote: '（按表格逐行提取日期、金额等字段）', hint: '核对合计数与源文件一致' }
        : { category: '关键条款', quote: '（摘录与审计目标相关的原文段落）', hint: '结合底稿目标判断是否影响认定' };
    }
    return { useCase: useCase, example: example };
  }

  function templateExtractablesHtml(rid) {
    var fs = getFields(rid);
    if (!fs.length) return '<li class="text-gray-600">暂无字段定义</li>';
    return fs.map(function (f) {
      return '<li class="text-sm text-gray-300 leading-relaxed">' + escapeHtml(f.label || f.key) + '</li>';
    }).join('');
  }

  function templateExampleHtml(example) {
    if (!example) return '';
    return '<div class="bg-gray-900/60 border border-gray-800 rounded-lg p-4 space-y-2">' +
      '<p class="text-xs text-gray-500">示例结果</p>' +
      '<p class="text-sm text-gray-300"><span class="text-gray-500">条款类别：</span>' + escapeHtml(example.category || '') + '</p>' +
      '<p class="text-sm text-gray-300"><span class="text-gray-500">原文摘录：</span>' + escapeHtml(example.quote || '') + '</p>' +
      '<p class="text-sm text-ey/90"><span class="text-gray-500 text-gray-400">审计提示：</span>' + escapeHtml(example.hint || '') + '</p>' +
      '</div>';
  }

  function templateAdvancedHtml(rule) {
    var prompt = rule.prompt || '';
    if (!prompt) return '';
    var body = '<pre class="text-xs text-gray-500 whitespace-pre-wrap font-mono max-h-72 overflow-auto ap-scroll bg-black border border-gray-800 rounded-lg p-3 mt-3">' +
      escapeHtml(prompt) + '</pre>';
    if (rule.readonly !== false && !RuleEngine.isCustomRuleId(rule.id)) {
      body += '<p class="text-xs text-gray-600 mt-2">需要修改？请使用「复制并编辑」创建我的模板。</p>';
    }
    return '<details class="ap-details mt-2">' +
      '<summary>高级规则 / Prompt 与 JSON 结构</summary>' +
      '<div class="ap-details-body">' + body + '</div></details>';
  }

  function templateDetailHtml(rid) {
    var rule = RuleEngine.getRule(rid);
    if (!rule) {
      return '<div class="card p-8 text-center text-gray-500 text-sm h-full flex flex-col items-center justify-center min-h-[320px]">' +
        '<p class="text-gray-400 mb-1">请从左侧选择一个模板</p><p class="text-xs text-gray-600">点击模板卡片后，此处显示字段与说明</p></div>';
    }
    var isCustom = RuleEngine.isCustomRuleId(rid);
    var pres = getTemplatePresentation(rule);
    var html = '<div class="card p-5 space-y-5 h-full min-h-[320px] border-2 border-gray-800 sticky top-6 ap-scroll overflow-y-auto max-h-[calc(100vh-14rem)]">' +
      '<div class="flex justify-between items-start gap-3 flex-wrap border-b border-gray-800 pb-4">' +
      '<div class="min-w-0"><p class="text-xs text-ey mb-1">模板详情</p>' +
      '<h3 class="font-semibold text-white text-lg">' + escapeHtml(rule.name) + '</h3>' +
      '<p class="text-xs text-gray-600 mt-2">版本 ' + escapeHtml(rule.version || '1.0') +
      ' · ' + templateKindLabel(rule) +
      (rule.readonly !== false && !isCustom ? ' · 内置模板' : ' · 我的模板') + '</p></div>' +
      '<div class="flex gap-2 flex-wrap shrink-0">';
    if (!isCustom && rule.readonly !== false) {
      html += '<button type="button" onclick="copyRuleAsCustom(\'' + rid + '\')" class="btn btn-sm">复制并编辑</button>';
    }
    if (isCustom) {
      if (editingCustomId !== rid) {
        html += '<button type="button" onclick="editCustomRule(\'' + rid + '\')" class="btn btn-sm">编辑</button>';
      }
      html += '<button type="button" onclick="deleteCustomRuleConfirm(\'' + rid + '\')" class="btn-sec btn-sm text-red-400">删除</button>';
    }
    html += '</div></div>';

    html += '<div><h4 class="text-sm font-medium text-gray-300 mb-2">适用场景</h4>' +
      '<p class="text-sm text-gray-400 leading-relaxed">' + escapeHtml(pres.useCase) + '</p></div>';

    html += '<div><h4 class="text-sm font-medium text-gray-300 mb-2">可提取内容</h4>' +
      '<ul class="list-disc list-inside space-y-1 text-gray-400">' + templateExtractablesHtml(rid) + '</ul></div>';

    html += templateExampleHtml(pres.example);

    if (isCustom && editingCustomId === rid) {
      html += '<div><h4 class="text-sm font-medium text-gray-300 mb-2">编辑提示词</h4>' +
        '<textarea id="customRulePrompt" class="w-full bg-black border border-gray-700 rounded-lg px-3 py-2 text-sm text-white font-mono h-64">' +
        escapeHtml(rule.prompt || '') + '</textarea>' +
        '<div class="flex gap-2 mt-2"><button type="button" onclick="saveCustomRulePrompt(\'' + rid + '\')" class="btn btn-sm">保存</button>' +
        '<button type="button" onclick="cancelEditCustomRule()" class="btn-sec btn-sm">取消</button></div></div>';
    } else if (rule.prompt) {
      html += templateAdvancedHtml(rule);
    }

    html += '<div id="ruleMsg" class="mt-2"></div></div>';
    return html;
  }

  global.pgRules = function () {
    var tab = typeof templateTab !== 'undefined' ? templateTab : 'all';
    var searchVal = typeof templateSearch !== 'undefined' ? templateSearch : '';
    var filtered = getFilteredTemplates();
    var rid = rulesViewId;
    if (!rid || !RuleEngine.getRule(rid) || (tab === 'custom' && !RuleEngine.isCustomRuleId(rid))) {
      rid = filtered.length > 0 ? filtered[0].id : (tab === 'custom' && CUSTOM_RULES[0] ? CUSTOM_RULES[0].id : RULE_ORDER[0]);
      rulesViewId = rid;
    } else if (filtered.length > 0 && !filtered.some(function (x) { return x.id === rid; })) {
      rid = filtered[0].id;
      rulesViewId = rid;
    }

    var html = '<div class="space-y-5">' +
      '<div class="flex justify-between items-start gap-3 flex-wrap"><div><h1 class="text-2xl font-bold text-white">提取模板库</h1>' +
      '<p class="text-sm text-gray-500 mt-2 max-w-3xl leading-relaxed">选择一个模板，系统会按预设字段从合同、单据或报告中提取关键信息。你也可以基于内置模板创建自己的模板。</p></div>' +
      '<button type="button" onclick="openBlankRuleModal()" class="btn btn-sm">新增模板</button></div>';

    html += '<div class="space-y-3"><div class="flex flex-wrap gap-2">' +
      templateTabBtn('all', '全部', tab) +
      templateTabBtn('contract', '合同协议', tab) +
      templateTabBtn('voucher', '单据票证', tab) +
      templateTabBtn('report', '报告', tab) +
      templateTabBtn('custom', '我的模板', tab) +
      '</div>' +
      '<div class="relative max-w-xl">' +
      '<input type="search" id="templateSearchInput" value="' + escapeHtml(searchVal) + '" oninput="onTemplateSearchInput(this.value)" placeholder="搜索模板，例如：借款合同、发票、征信报告" class="w-full bg-black border border-gray-700 rounded-lg pl-4 pr-4 py-2.5 text-sm text-white placeholder:text-gray-600 focus:border-ey">' +
      '</div></div>';

    html += '<div class="flex gap-5 items-start min-h-[calc(100vh-14rem)]">' +
      '<div class="w-[42%] shrink-0 space-y-3 max-h-[calc(100vh-14rem)] overflow-y-auto ap-scroll pr-1">';

    if (tab === 'custom' && CUSTOM_RULES.length === 0) {
      html += '<div class="card p-8 text-center text-gray-500 text-sm">' +
        '<p class="text-gray-400 mb-2">还没有我的模板</p>' +
        '<p class="text-xs text-gray-600 mb-4">可以从空白骨架新增，也可以在内置模板上点击「复制并编辑」创建</p>' +
        '<button type="button" onclick="openBlankRuleModal()" class="btn btn-sm">新增模板</button></div>';
    } else if (filtered.length === 0) {
      html += '<div class="card p-8 text-center text-gray-500 text-sm">未找到匹配的模板，请换个关键词或切换分类</div>';
    } else {
      html += '<p class="text-xs text-gray-600 px-1">共 ' + filtered.length + ' 个模板 · 点击卡片查看右侧详情</p>' +
        '<p class="text-xs text-gray-500 px-1">不确定选哪个？可以先上传文件，系统会自动推荐模板。</p>';
      filtered.forEach(function (item) {
        html += templateCardHtml(item, rid);
      });
    }

    html += '</div><div class="flex-1 min-w-0">' + templateDetailHtml(rid) + '</div></div></div>';
    return html;
  };

  global.setTemplateTab = function (tab) {
    templateTab = tab;
    editingCustomId = null;
    render();
  };

  var templateSearchTimer = null;
  global.onTemplateSearchInput = function (val) {
    templateSearch = val;
    if (templateSearchTimer) clearTimeout(templateSearchTimer);
    var cursor = val.length;
    templateSearchTimer = setTimeout(function () {
      render();
      var el = document.getElementById('templateSearchInput');
      if (el) {
        el.focus();
        try { el.setSelectionRange(cursor, cursor); } catch (e) {}
      }
    }, 180);
  };

  global.viewRule = function (id) {
    rulesViewId = id;
    editingCustomId = null;
    if (RuleEngine.isCustomRuleId(id)) templateTab = 'custom';
    render();
  };

  global.openBlankRuleModal = function () {
    var root = ensureModalRoot();
    root.innerHTML = '<div class="modal-backdrop fixed inset-0 bg-black/70 flex items-center justify-center" onclick="if(event.target===this)cm()">' +
      '<div class="bg-gray-900 border border-gray-700 rounded-xl p-5 w-full max-w-md mx-4 shadow-2xl" onclick="event.stopPropagation()">' +
      '<h3 class="font-semibold text-white mb-1">新增模板</h3>' +
      '<p class="text-xs text-gray-500 mb-4">从带基础字段结构的空白提示词开始创建，保存后可继续编辑。</p>' +
      '<div class="space-y-3">' +
      '<div><label class="text-xs text-gray-400 block mb-1">模板名称</label><input id="blankRuleName" type="text" autocomplete="off" class="w-full bg-black border border-gray-700 rounded-lg px-3 py-2 text-sm text-white" placeholder="例如：租赁合同审计模板"></div>' +
      '<div><label class="text-xs text-gray-400 block mb-1">文档类型</label><select id="blankRuleKind" class="w-full bg-black border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"><option value="contract">条款型：合同、协议、报告段落</option><option value="table">表格型：发票、流水、明细清单</option></select></div>' +
      '<div class="flex gap-2 pt-1"><button type="button" onclick="cm()" class="flex-1 border border-gray-700 py-2 rounded-lg text-sm text-gray-400 hover:bg-gray-800">取消</button>' +
      '<button type="button" onclick="confirmBlankRule()" class="flex-1 btn btn-sm">创建并编辑</button></div></div></div></div>';
    setTimeout(function () {
      var el = document.getElementById('blankRuleName');
      if (el) el.focus();
    }, 50);
  };

  global.confirmBlankRule = function () {
    var nameEl = document.getElementById('blankRuleName');
    var kindEl = document.getElementById('blankRuleKind');
    var name = nameEl ? nameEl.value.trim() : '';
    var kind = kindEl ? kindEl.value : 'contract';
    if (!name) { alert('请输入模板名称'); return; }
    var rule = RuleEngine.createBlankCustomRule(name, kind);
    if (!rule) { alert('创建失败'); return; }
    CUSTOM_RULES = RuleEngine.getCustomRules();
    save();
    cm();
    rulesViewId = rule.id;
    templateTab = 'custom';
    editingCustomId = rule.id;
    render();
  };

  global.copyRuleAsCustom = function (builtinId) {
    var baseName = RuleEngine.getRuleName(builtinId) + '（我的模板）';
    var root = ensureModalRoot();
    root.innerHTML = '<div class="modal-backdrop fixed inset-0 bg-black/70 flex items-center justify-center" onclick="if(event.target===this)cm()">' +
      '<div class="bg-gray-900 border border-gray-700 rounded-xl p-5 w-full max-w-sm mx-4 shadow-2xl" onclick="event.stopPropagation()">' +
      '<h3 class="font-semibold text-white mb-1">复制并编辑</h3>' +
      '<p class="text-xs text-gray-500 mb-4">基于此模板创建我的模板，之后可修改提示词与字段。</p>' +
      '<input id="customRuleName" type="text" autocomplete="off" class="w-full bg-black border border-gray-700 rounded-lg px-3 py-2 text-sm text-white mb-4" value="' + escapeHtml(baseName) + '">' +
      '<div class="flex gap-2"><button type="button" onclick="cm()" class="flex-1 border border-gray-700 py-2 rounded-lg text-sm text-gray-400 hover:bg-gray-800">取消</button>' +
      '<button type="button" onclick="confirmCopyRuleAsCustom(\'' + builtinId + '\')" class="flex-1 btn btn-sm">创建</button></div></div></div>';
    setTimeout(function () {
      var el = document.getElementById('customRuleName');
      if (el) { el.focus(); el.select(); }
    }, 50);
  };

  global.confirmCopyRuleAsCustom = function (builtinId) {
    var el = document.getElementById('customRuleName');
    var name = el ? el.value.trim() : '';
    if (!name) { alert('请输入模板名称'); return; }
    cm();
    var rule = RuleEngine.copyBuiltinAsCustom(builtinId, name);
    if (!rule) { alert('创建失败'); return; }
    CUSTOM_RULES = RuleEngine.getCustomRules();
    save();
    rulesViewId = rule.id;
    templateTab = 'custom';
    editingCustomId = rule.id;
    render();
  };

  global.editCustomRule = function (id) {
    rulesViewId = id;
    editingCustomId = id;
    render();
  };

  global.cancelEditCustomRule = function () {
    editingCustomId = null;
    render();
  };

  global.saveCustomRulePrompt = function (id) {
    var ta = document.getElementById('customRulePrompt');
    if (!ta) return;
    var t = ta.value.trim();
    if (!t) { alert('提示词不能为空'); return; }
    if (!t.includes('【字段定义】')) { alert('提示词须包含【字段定义】区块'); return; }
    RuleEngine.updateCustomRule(id, { prompt: t });
    CUSTOM_RULES = RuleEngine.getCustomRules();
    save();
    editingCustomId = null;
    var el = document.getElementById('ruleMsg');
    if (el) el.innerHTML = '<div class="text-sm text-emerald-400 bg-emerald-900 rounded-lg p-2">我的模板已保存</div>';
    render();
  };

  global.deleteCustomRuleConfirm = function (id) {
    if (!confirm('确认删除该模板？已有提取结果不会自动删除。')) return;
    RuleEngine.deleteCustomRule(id);
    CUSTOM_RULES = RuleEngine.getCustomRules();
    if (rulesViewId === id) rulesViewId = RULE_ORDER[0];
    if (activeRuleId === id) activeRuleId = RULE_ORDER[0];
    save();
    render();
  };

  global.switchContractRule = function (ruleId) {
    activeRuleId = ruleId;
    if (typeof selectedWorkRowId !== 'undefined') selectedWorkRowId = null;
    activeFieldSetId = FieldSet.latestFieldSetId(cid, ruleId);
    render();
  };

  global.openFieldSelectModal = function (opts) {
    opts = opts || {};
    var mode = opts.mode || 'single';
    var ruleId = opts.ruleId || activeRuleId;
    var projectId = opts.projectId || pid;
    var allFields = RuleEngine.getFieldsForRule(ruleId);
    var pk = pageKey(ruleId);
    var selected = FieldSet.resolveFieldKeys(projectId, ruleId);
    var requireAllFields = ruleId === 'revenue_workpaper';
    var root = ensureModalRoot();
    var checks = allFields.map(function (f) {
      var isPage = pk && f.key === pk;
      var isRequired = isPage || requireAllFields;
      var checked = selected.indexOf(f.key) >= 0 || isPage;
      return '<label class="flex items-start gap-2 text-sm text-gray-300 cursor-pointer py-1.5' + (isRequired ? ' opacity-90' : '') + '">' +
        '<input type="checkbox" class="field-sel-cb mt-0.5 w-4 h-4 rounded border-gray-700 bg-black text-ey" value="' + escapeHtml(f.key) + '"' +
        (checked || requireAllFields ? ' checked' : '') + (isRequired ? ' disabled data-required="1"' : '') + '>' +
        '<span><span class="text-white">' + escapeHtml(f.label) + '</span>' +
        (isRequired ? ' <span class="text-xs text-ey">（必选）</span>' : '') +
        '<span class="block text-xs text-gray-600 font-mono">' + escapeHtml(f.key) + '</span></span></label>';
    }).join('');

    root.innerHTML = '<div class="modal-backdrop fixed inset-0 bg-black/70 flex items-center justify-center" onclick="if(event.target===this)cm()">' +
      '<div class="bg-gray-900 border border-gray-700 rounded-xl p-5 w-full max-w-lg mx-4 shadow-2xl max-h-[85vh] flex flex-col" onclick="event.stopPropagation()">' +
      '<h3 class="font-semibold text-white mb-1">选择提取字段</h3>' +
      '<p class="text-xs text-gray-500 mb-3">模板：' + escapeHtml(RuleEngine.getRuleName(ruleId)) +
      (requireAllFields ? ' · 收入底稿判断字段相互关联，本模板固定保留全部字段</p>' : ' · 勾选结果将记入本项目，页码字段强制保留</p>') +
      '<div class="flex gap-2 mb-2">' +
      '<button type="button" onclick="fieldSelSelectAll(true)" class="btn-sec btn-sm text-xs">全选</button>' +
      '<button type="button" onclick="fieldSelSelectAll(false)" class="btn-sec btn-sm text-xs">仅必选</button></div>' +
      '<div class="flex-1 overflow-y-auto ap-scroll border border-gray-800 rounded-lg px-3 py-2 mb-4 space-y-0.5">' + checks + '</div>' +
      '<div class="flex gap-2">' +
      '<button type="button" onclick="cm()" class="flex-1 border border-gray-700 py-2 rounded-lg text-sm text-gray-400">取消</button>' +
      '<button type="button" onclick="confirmFieldSelect(\'' + mode + '\')" class="flex-1 btn btn-sm">开始提取</button>' +
      '</div></div></div>';
    window.__fieldSelectCtx = opts;
  };

  global.fieldSelSelectAll = function (all) {
    document.querySelectorAll('.field-sel-cb').forEach(function (cb) {
      if (cb.disabled || cb.getAttribute('data-required') === '1') { cb.checked = true; return; }
      cb.checked = !!all;
    });
  };

  global.confirmFieldSelect = function (mode) {
    var ctx = window.__fieldSelectCtx || {};
    var keys = [];
    document.querySelectorAll('.field-sel-cb').forEach(function (cb) {
      if (cb.checked || cb.disabled) keys.push(cb.value);
    });
    var ruleId = ctx.ruleId || activeRuleId;
    keys = FieldSet.ensurePageInKeys(ruleId, keys);
    if (keys.length === 0) { alert('请至少选择一个字段'); return; }
    cm();
    if (mode === 'batch') {
      runBatchExtractWithFields(keys, ctx);
    } else {
      runSingleExtractWithFields(keys);
    }
  };

  global.setContractDefaultRule = function (contractId, ruleId) {
    var c = gc(contractId);
    if (!c) return;
    c.ruleId = ruleId;
    c.ruleConfirmed = false;
    activeRuleId = ruleId;
    save();
    render();
  };

  function isRevenueWorkpaperRule(ruleId) {
    return ruleId === 'revenue_workpaper';
  }

  function visibleWorkpaperItems(ruleId, items) {
    items = items || [];
    if (!isRevenueWorkpaperRule(ruleId) || !global.RevenueWorkpaper || typeof global.RevenueWorkpaper.visibleItems !== 'function') {
      return items;
    }
    return global.RevenueWorkpaper.visibleItems(items);
  }

  function fileAssociationSummary(contractId) {
    if (typeof global.getFileAssociationSummary !== 'function') {
      return { count: 0, documents: [], needsRefresh: false };
    }
    try {
      var summary = global.getFileAssociationSummary(contractId) || {};
      return {
        count: Number(summary.count) || 0,
        documents: Array.isArray(summary.documents) ? summary.documents : [],
        needsRefresh: !!summary.needsRefresh
      };
    } catch (err) {
      return { count: 0, documents: [], needsRefresh: false };
    }
  }

  function escapeHtmlAttribute(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function inlineJsArg(value) {
    return escapeHtmlAttribute(JSON.stringify(String(value || '')));
  }

  function fileAssociationPanelHtml(contractId, hasResults) {
    var summary = fileAssociationSummary(contractId);
    var linkedDocuments = summary.documents.filter(function (doc) { return doc && !doc.isPrimary; });
    var linkedRows = linkedDocuments.length ? linkedDocuments.map(function (doc) {
      var name = doc.name || '关联文件';
      var role = doc.docType || '其他支持文件';
      return '<div class="flex items-center gap-2 min-w-0 py-1">' +
        '<span class="text-xs text-gray-300 truncate" title="' + escapeHtmlAttribute(name) + '">' + escapeHtml(name) + '</span>' +
        '<span class="text-xs text-gray-600 shrink-0">' + escapeHtml(role) + '</span></div>';
    }).join('') : '<p class="text-xs text-gray-600">未关联其他资料</p>';
    var buttonLabel = summary.count > 0 ? '管理关联' : '关联资料';
    var refreshHint = hasResults && summary.needsRefresh
      ? '<p class="text-xs text-amber-400 mt-1">关联已更新，重新提取后生效</p>'
      : '';
    return '<div class="border border-gray-800 rounded-lg px-3 py-2 bg-black/30">' +
      '<div class="flex items-start justify-between gap-3">' +
      '<div class="min-w-0 flex-1"><div class="flex items-center gap-2 flex-wrap">' +
      '<p class="text-sm font-medium text-white">关联资料</p>' +
      (summary.count > 0 ? '<span class="text-xs text-emerald-400">已关联' + summary.count + '份</span>' : '') +
      '</div><div class="mt-1 space-y-0.5">' + linkedRows + '</div>' + refreshHint + '</div>' +
      '<button type="button" onclick="openFileAssociationModal(' + inlineJsArg(contractId) + ')" class="btn-outline btn-sm px-3 py-1.5 rounded-lg text-xs shrink-0">' + buttonLabel + '</button>' +
      '</div></div>';
  }

  function revenueWorkpaperPanelHtml(contractId, hasExtracted, fieldSetId, mode) {
    var contract = gc(contractId);
    var supplements = contract && contract.supplements ? contract.supplements : [];
    var currentItems = hasExtracted && fieldSetId ? FieldSet.gvFieldSet(contractId, 'revenue_workpaper', fieldSetId) : [];
    var missingTasks = global.RevenueWorkpaper ? global.RevenueWorkpaper.buildMissingTasks(currentItems) : [];
    var exportDisabled = hasExtracted ? '' : ' disabled';
    var exportAction = hasExtracted
      ? ' onclick="exportRevenueWorkpaperChecklist(\'' + contractId + '\',\'' + (fieldSetId || '') + '\')"'
      : '';
    var reviewAction = hasExtracted
      ? ' onclick="runRevenueDeepReview(\'' + contractId + '\',\'' + (fieldSetId || '') + '\')"'
      : '';
    var supplementRows = supplements.length ? supplements.map(function (s) {
      return '<div class="flex items-center gap-2 py-2 border-t border-gray-800 first:border-t-0">' +
        '<div class="flex-1 min-w-0"><p class="text-xs text-gray-200 truncate" title="' + escapeHtml(s.file || '') + '">' + escapeHtml(s.file || '补充资料') + '</p>' +
        '<p class="text-xs text-gray-600">' + escapeHtml(s.docType || '补充资料') + ' · <span class="' + (s.status === '已吸收' ? 'text-emerald-400' : 'text-amber-400') + '">' + escapeHtml(s.status || '待处理') + '</span>' +
        (s.requestText ? ' · 用于：' + escapeHtml(s.requestText) : '') + '</p></div>' +
        '<button type="button" onclick="removeRevenueSupplement(\'' + contractId + '\',\'' + s.id + '\')" class="text-gray-600 hover:text-red-400 text-sm px-1" title="从当前合同资料包移除">×</button></div>';
    }).join('') : '<p class="text-xs text-gray-600 py-2">尚未添加工作说明书、补充协议、信用资料等补充文件</p>';
    var taskRows = missingTasks.length ? missingTasks.slice(0, 8).map(function (task) {
      var encoded = encodeURIComponent(task.text).replace(/'/g, '%27');
      return '<div class="flex items-start gap-3 py-2 border-t border-gray-800 first:border-t-0">' +
        '<span class="text-xs mt-0.5 ' + (task.blocking ? 'text-red-400' : 'text-amber-400') + '">' + (task.blocking ? '阻断结论' : '补充留档') + '</span>' +
        '<div class="flex-1 min-w-0"><p class="text-xs text-gray-300 leading-relaxed">' + escapeHtml(task.text) + '</p><p class="text-xs text-gray-600 mt-0.5">影响问题：' + escapeHtml(task.questionNos.join('、')) + '</p></div>' +
        '<button type="button" onclick="pickRevenueSupplement(\'' + contractId + '\',\'' + encoded + '\')" class="btn-outline btn-sm px-2 py-1 rounded text-xs shrink-0">上传资料</button></div>';
    }).join('') : '<p class="text-xs text-emerald-500 py-2">当前没有待补资料任务</p>';
    var panelBody = '<div class="p-4 space-y-4 border-t border-gray-800">' +
      '<div class="flex flex-wrap gap-2">' +
      '<button type="button"' + exportAction + exportDisabled + ' class="btn btn-sm">导出底稿填列清单</button>' +
      '<button type="button" onclick="pickRevenueSupplement(\'' + contractId + '\',\'\')" class="btn-outline btn-sm px-3 py-1.5 rounded-lg text-xs">添加补充资料</button>' +
      (hasExtracted && contract && contract.revenueNeedsRefresh ? '<button type="button" onclick="reanalyzeRevenueContract(\'' + contractId + '\')" class="btn btn-sm">更新判断</button>' : '') +
      '<button type="button"' + reviewAction + exportDisabled + ' class="btn-outline btn-sm px-3 py-1.5 rounded-lg text-xs" title="可选：再次调用AI合并冲突并复核当前清单，可随时停止">深度复核</button>' +
      '</div>' +
      '<div class="grid lg:grid-cols-2 gap-4 pt-2 border-t border-gray-800">' +
      '<div><div class="flex items-center justify-between gap-2"><p class="text-xs font-medium text-gray-300">合同资料包</p><span class="text-xs text-gray-600">主合同 + ' + supplements.length + '份补充资料</span></div>' + supplementRows + '</div>' +
      '<div><div class="flex items-center justify-between gap-2"><p class="text-xs font-medium text-gray-300">待补资料</p><span class="text-xs text-gray-600">' + missingTasks.length + '项</span></div>' + taskRows + '</div></div></div>';
    var statusText = hasExtracted
      ? (contract && contract.revenueNeedsRefresh ? '待更新判断' : '已同步')
      : '待提取';
    var statusClass = hasExtracted && !(contract && contract.revenueNeedsRefresh) ? 'text-emerald-400' : 'text-amber-400';
    return '<details class="border border-gray-800 rounded-lg bg-black/30"' + (mode === 'flow' ? ' open' : '') + '>' +
      '<summary class="cursor-pointer select-none px-4 py-3 flex items-center justify-between gap-3 hover:bg-gray-900/70">' +
      '<div class="flex items-center gap-3 min-w-0"><span class="text-sm font-medium text-white">资料包与补充任务</span>' +
      '<span class="text-xs text-gray-500">补充资料 ' + supplements.length + ' 份 · 待办 ' + missingTasks.length + ' 项</span></div>' +
      '<span class="text-xs ' + statusClass + '">' + statusText + '</span></summary>' + panelBody + '</details>';
  }

  global.onFlowTemplateChange = function (contractId, ruleId) {
    setContractDefaultRule(contractId, ruleId);
  };

  global.fileFlowCardHtml = function (contractId) {
    var c = gc(contractId);
    if (!c) return '';
    var rid = getContractRuleId(c);
    var sets = FieldSet.listFieldSets(contractId, activeRuleId);
    var latestId = sets.length ? sets[0].id : null;
    var vs = visibleWorkpaperItems(activeRuleId, latestId ? FieldSet.gvFieldSet(contractId, activeRuleId, latestId) : []);
    var hasExtracted = sets.length > 0;
    var confirmed = !!c.ruleConfirmed;
    var conf = c.detectedConfidence || 'low';
    var confLabel = conf === 'high' ? '高' : conf === 'medium' ? '中' : '低';
    var confCls = conf === 'high' ? 'text-emerald-400' : conf === 'medium' ? 'text-amber-400' : 'text-red-400';
    var aiLabel = c.docLabel || (c.detectedRuleId ? RuleEngine.getRuleName(c.detectedRuleId) : RuleEngine.getRuleName(rid));
    var ruleName = RuleEngine.getRuleName(rid);
    var setCount = FieldSet.listFieldSets(contractId, activeRuleId).length;
    var hasAnyResults = getAppliedRuleIds(contractId).length > 0;

    var html = '<div class="card p-4 space-y-4"><div class="flex items-center justify-between gap-3 flex-wrap">' +
      '<h3 class="font-medium text-white text-sm">当前文件处理流程</h3>' +
      '<p class="text-xs text-gray-600">本模板 ' + vs.length + ' 条' + (setCount > 1 ? ' · ' + setCount + ' 套底稿' : '') +
      ' · 已用 ' + getAppliedRuleIds(contractId).length + ' 种模板</p></div>';

    html += fileAssociationPanelHtml(contractId, hasAnyResults);

    html += '<div class="border border-gray-800 rounded-lg p-3 bg-black/30">' +
      '<div class="flex items-start gap-3">' +
      '<span class="w-6 h-6 rounded-full bg-gray-800 text-gray-300 text-xs flex items-center justify-center shrink-0">1</span>' +
      '<div class="flex-1 min-w-0 space-y-2"><div class="flex justify-between items-start gap-2 flex-wrap">' +
      '<div><p class="text-sm font-medium text-white">模板确认</p>' +
      '<p class="text-xs text-gray-500 mt-0.5">AI 判断：<span class="text-gray-300">' + escapeHtml(aiLabel) + '</span> · 置信度：<span class="' + confCls + '">' + confLabel + '</span> · <span class="' + (confirmed ? 'text-emerald-400' : 'text-amber-400') + '">' + (confirmed ? '已确认' : '待确认') + '</span></p></div>' +
      '</div>' +
      (c.detectedReason ? '<p class="text-xs text-gray-600 leading-relaxed">' + escapeHtml(c.detectedReason) + '</p>' : '') +
      '<div class="flex flex-wrap items-center gap-2"><span class="text-xs text-gray-500">' + (confirmed ? '已使用模板' : '当前模板') + '</span>' +
      '<select id="docRuleSel_' + contractId + '" onchange="onFlowTemplateChange(\'' + contractId + '\',this.value)" class="bg-black border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-white">' +
      ruleSelectOptionsHtml(rid) + '</select>' +
      (!confirmed ? '<button type="button" onclick="confirmDocRule(\'' + contractId + '\',document.getElementById(\'docRuleSel_' + contractId + '\').value)" class="btn-outline btn-sm px-3 py-1.5 rounded-lg text-xs">确认模板</button>' : '<span class="text-xs px-2 py-1 rounded bg-emerald-900/40 text-emerald-400 border border-emerald-800">模板已确认</span>') +
      '</div></div></div></div>';

    html += '<div class="border border-gray-800 rounded-lg p-3 bg-black/30">' +
      '<div class="flex items-start gap-3"><span class="w-6 h-6 rounded-full bg-gray-800 text-gray-300 text-xs flex items-center justify-center shrink-0">2</span>' +
      '<div class="flex-1 min-w-0"><div class="flex justify-between gap-3 flex-wrap items-center">' +
      '<div><p class="text-sm font-medium text-white">字段选择与提取</p>' +
      '<p class="text-xs text-gray-500 mt-0.5">模板：<span class="text-gray-300">' + escapeHtml(ruleName) + '</span>。开始前会让你勾选本次要提取的字段。</p></div>' +
      '<button type="button" onclick="re()" id="eb" class="btn btn-sm">' + (hasExtracted ? '重新提取' : '选择字段并开始提取') + '</button>' +
      '</div></div></div></div>';

    html += '<div class="border border-gray-800 rounded-lg p-3 bg-black/30">' +
      '<div class="flex items-start gap-3"><span class="w-6 h-6 rounded-full bg-gray-800 text-gray-300 text-xs flex items-center justify-center shrink-0">3</span>' +
      '<div class="flex-1 min-w-0"><div class="flex justify-between gap-3 flex-wrap items-center">' +
      '<div><p class="text-sm font-medium text-white">底稿查看与导出</p>' +
      '<p class="text-xs text-gray-500 mt-0.5">' + (hasExtracted ? '当前模板已有 ' + vs.length + ' 条结果。' : '提取完成后可查看底稿并导出 Excel。') + '</p></div>' +
      '<div class="flex flex-wrap items-center gap-2">' +
      (hasExtracted ? '<button type="button" onclick="nav(\'work\',{cid:\'' + contractId + '\',ruleId:\'' + activeRuleId + '\'})" class="btn btn-sm">查看底稿(' + vs.length + ')</button>' : '<button type="button" disabled class="btn-outline btn-sm px-3 py-1.5 rounded-lg text-xs">查看底稿</button>') +
      '<button type="button" onclick="exportToExcel(\'' + contractId + '\',false,\'' + activeRuleId + '\')" class="btn-outline btn-sm px-3 py-1.5 rounded-lg text-xs">导出当前底稿</button>' +
      '<button type="button" onclick="exportToExcel(\'' + contractId + '\',false,null,true)" class="btn-outline btn-sm px-3 py-1.5 rounded-lg text-xs">导出全部底稿</button>' +
      '<div class="ap-menu-wrap relative inline-block">' +
      '<button type="button" onclick="toggleFlowMenu()" class="btn-outline btn-sm px-3 py-1.5 rounded-lg text-xs">更多操作 ▾</button>' +
      '<div id="flowMoreMenu" class="hidden absolute right-0 mt-1 bg-gray-900 border border-gray-700 rounded-lg shadow-xl z-30 min-w-[160px] py-1">';
    if (hasExtracted) {
      html += '<button type="button" onclick="closeFlowMenu();re()" class="block w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-gray-800">重新提取</button>';
    }
    html += '<button type="button" onclick="closeFlowMenu();exportToExcel(\'' + contractId + '\',false,\'' + activeRuleId + '\')" class="block w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-gray-800">导出当前底稿</button>' +
      '<button type="button" onclick="closeFlowMenu();exportToExcel(\'' + contractId + '\',false,null,true)" class="block w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-gray-800">导出全部底稿</button>' +
      '</div></div></div></div></div></div></div>';
    if (isRevenueWorkpaperRule(activeRuleId)) {
      html += revenueWorkpaperPanelHtml(contractId, hasExtracted, latestId, 'flow');
    }
    return html;
  };

  global.toggleFlowMenu = function () {
    var el = document.getElementById('flowMoreMenu');
    if (el) el.classList.toggle('hidden');
  };
  global.closeFlowMenu = function () {
    var el = document.getElementById('flowMoreMenu');
    if (el) el.classList.add('hidden');
  };

  function isLongField(key) {
    return /excerpt|summary|auditor|原文|摘录|提示|remark|content|desc/i.test(key || '');
  }

  function revenueDisplayValue(item, key, ruleId) {
    if (!isRevenueWorkpaperRule(ruleId) || !item) return item && item[key] != null ? item[key] : '';
    if (key === 'question_no') return item.display_question_no || item.question_no || '';
    if (key === 'question_description') return item.display_question_description || item.question_description || '';
    return item[key] != null ? item[key] : '';
  }

  function fieldsForWorkView(ruleId, fieldSetId, contractId) {
    ruleId = ruleId || activeRuleId;
    contractId = contractId || cid;
    if (fieldSetId) {
      var sample = FieldSet.gvFieldSet(contractId || '', ruleId, fieldSetId)[0];
      if (sample && sample.fieldKeys) return FieldSet.fieldsForKeys(ruleId, sample.fieldKeys);
      var sets = FieldSet.listFieldSets(contractId, ruleId);
      var hit = sets.find(function (s) { return s.id === fieldSetId; });
      if (hit) return FieldSet.fieldsForKeys(ruleId, hit.keys);
    }
    return getFields(ruleId);
  }

  function getSummaryFields(ruleId, fieldSetId, contractId) {
    var fs = fieldsForWorkView(ruleId, fieldSetId, contractId);
    if (isRevenueWorkpaperRule(ruleId)) {
      var wanted = ['question_no', 'question_description', 'suggested_answer', 'fill_readiness', 'pages'];
      return wanted.map(function (key) {
        return fs.find(function (f) { return f.key === key; });
      }).filter(Boolean);
    }
    var pk = pageKey(ruleId);
    var out = [];
    if (pk) {
      var pf = fs.find(function (f) { return f.key === pk; });
      if (pf) out.push(pf);
    }
    fs.forEach(function (f) {
      if (f.key === pk || isLongField(f.key)) return;
      if (out.some(function (x) { return x.key === f.key; })) return;
      if (out.length >= 4) return;
      out.push(f);
    });
    return out;
  }

  function parsePageNum(pageStr) {
    if (!pageStr) return null;
    var m = String(pageStr).match(/第(\d+)页/);
    if (m) return parseInt(m[1], 10);
    var n = parseInt(pageStr, 10);
    return isNaN(n) ? null : n;
  }

  function inlineJsValue(value) {
    return escapeHtml(String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n'));
  }

  function htmlAttributeValue(value) {
    return escapeHtml(String(value || '')).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function parseEvidenceRefs(item) {
    var raw = item && item.evidence_refs;
    var refs = [];
    if (Array.isArray(raw)) refs = raw;
    else if (raw) {
      try { refs = JSON.parse(raw); } catch (ignore) { refs = []; }
    }
    refs = (Array.isArray(refs) ? refs : []).map(function (ref) {
      if (!ref || typeof ref !== 'object') return null;
      var sourceId = String(ref.source_id || ref.sourceId || '').trim();
      var source = String(ref.source_document || ref.source || ref.file || '').trim();
      var pages = String(ref.pages || ref.page || '').trim();
      return source ? { sourceId: sourceId, source: source, pages: pages || '【页码未知】' } : null;
    }).filter(Boolean);
    if (refs.length) return refs;

    var sources = String((item && item.source_documents) || '').split(/[；;]/).map(function (value) { return value.trim(); }).filter(Boolean);
    var pageText = String((item && item.pages) || '');
    var pages = pageText.match(/【[^】]+】/g) || pageText.split(/[、；;]/).map(function (value) { return value.trim(); }).filter(Boolean);
    if (sources.length === 1 && pages.length) return pages.map(function (page) { return { sourceId: '', source: sources[0], pages: page }; });
    if (sources.length > 1 && sources.length === pages.length) return sources.map(function (source, index) { return { sourceId: '', source: source, pages: pages[index] }; });
    return [];
  }

  function compactEvidencePageText(value) {
    var text = String(value || '').trim();
    var match = text.match(/第\s*(\d+)\s*(?:[-~～—–至到]\s*(\d+))?\s*页/);
    if (!match) return /页码未知/.test(text) ? '页码未知' : text;
    return match[2] ? '第' + match[1] + '–' + match[2] + '页' : '第' + match[1] + '页';
  }

  function evidenceLinksHtml(item, compact) {
    var refs = parseEvidenceRefs(item);
    var buttonClass = compact
      ? 'inline-flex items-center px-2 py-1 mr-1 mb-1 rounded border border-blue-800 text-blue-300 hover:bg-blue-950/40'
      : 'btn-outline btn-sm px-3 py-1.5 rounded-lg text-xs';
    if (refs.length) {
      return refs.map(function (ref) {
        var label = compactEvidencePageText(ref.pages) || '页码未知';
        return '<button type="button" title="' + htmlAttributeValue(ref.source + ' ' + ref.pages) + '" onclick="event.stopPropagation();jumpToEvidence(\'' + inlineJsValue(item.contractId || '') + '\',\'' + inlineJsValue(ref.source) + '\',\'' + inlineJsValue(ref.pages) + '\',\'' + inlineJsValue(ref.sourceId) + '\',\'' + inlineJsValue(item.id || '') + '\')" class="' + buttonClass + '">' + escapeHtml(label) + '</button>';
      }).join('');
    }
    if (!item.pages && !item.source_documents) return compact ? '—' : '';
    return '<button type="button" onclick="event.stopPropagation();jumpToEvidence(\'' + inlineJsValue(item.contractId || '') + '\',\'' + inlineJsValue(item.source_documents || '') + '\',\'' + inlineJsValue(item.pages || '') + '\',\'\',\'' + inlineJsValue(item.id || '') + '\')" class="' + buttonClass + '">' + (compact ? '选择来源/页码' : '选择来源文件和页码') + '</button>';
  }

  function workRowMatchesFilter(v, ruleId, q, fieldSetId) {
    if (!q) return true;
    q = q.toLowerCase();
    return fieldsForWorkView(ruleId, fieldSetId).some(function (f) {
      return String(revenueDisplayValue(v, f.key, ruleId) || '').toLowerCase().indexOf(q) >= 0;
    });
  }

  function workSummaryRowHtml(v, i, ruleId, selected, fieldSetId) {
    var cols = getSummaryFields(ruleId, fieldSetId);
    var bg = i % 2 === 0 ? 'bg-black' : 'bg-gray-900';
    var activeCls = selected ? ' work-row-active' : '';
    var pk = pageKey(ruleId);
    var html = '<tr class="work-row border-b border-gray-800 cursor-pointer hover:bg-gray-800/50 ' + bg + activeCls + '" data-id="' + v.id + '" onclick="selectWorkRow(\'' + v.id + '\')">';
    cols.forEach(function (f) {
      if (f.key === pk) {
        html += '<td class="p-2 text-xs text-ey">' + evidenceLinksHtml(v, true) + '</td>';
      } else {
        var value = revenueDisplayValue(v, f.key, ruleId) || '';
        var isDetailRow = isRevenueWorkpaperRule(ruleId) && (v.appendix_detail_type || v._structured_detail || /^5\.1\.[12]-/.test(String(v.question_no || '')) || /^2\.1-PO#/.test(String(v.question_no || '')));
        var prefix = isDetailRow && f.key === 'question_description'
          ? '<span class="text-blue-400 mr-1">↳ ' + escapeHtml(v.workpaper_sheet || '附表') + '</span>'
          : '';
        html += '<td class="p-2 text-xs text-gray-300 max-w-[220px] truncate" title="' + htmlAttributeValue(value) + '">' + prefix + escapeHtml(value || '—') + '</td>';
      }
    });
    html += '<td class="p-2 text-xs whitespace-nowrap">' +
      '<button type="button" onclick="event.stopPropagation();toggleReviewed(\'' + v.id + '\')" class="' + (v.reviewed ? 'text-emerald-400' : 'text-gray-500 hover:text-gray-300') + '">' +
      (v.reviewed ? '已复核' : '待复核') + '</button></td></tr>';
    return html;
  }

  function workRowDetailHtml(itemId, ruleId, fieldSetId) {
    if (!itemId) {
      return '<div class="card p-6 text-center text-gray-500 text-sm"><p class="text-gray-400">点击上方行查看详情</p><p class="text-xs text-gray-600 mt-1">原文摘录与审计提示将在此展示</p></div>';
    }
    var v = V.find(function (x) { return x.id === itemId; });
    if (!v) return '';
    ruleId = ruleId || activeRuleId;
    if (isRevenueWorkpaperRule(ruleId)) {
      var visibleRevenueItems = visibleWorkpaperItems(ruleId, FieldSet.gvFieldSet(v.contractId || cid, ruleId, fieldSetId || v.fieldSetId));
      if (!visibleRevenueItems.some(function (item) { return item.id === itemId; })) {
        return '<div class="card p-6 text-center text-gray-500 text-sm"><p class="text-gray-400">请选择可见问题查看详情</p></div>';
      }
      var mapped = global.RevenueWorkpaper ? global.RevenueWorkpaper.findQuestion(v) : null;
      var targetHtml = mapped
        ? '<div class="grid grid-cols-3 gap-2 text-xs"><div class="bg-black/40 border border-gray-800 rounded p-2"><span class="text-gray-500 block">回答</span><span class="text-ey">' + escapeHtml(mapped.answerCell) + '</span></div><div class="bg-black/40 border border-gray-800 rounded p-2"><span class="text-gray-500 block">理由</span><span class="text-ey">' + escapeHtml(mapped.reasonCell) + '</span></div><div class="bg-black/40 border border-gray-800 rounded p-2"><span class="text-gray-500 block">摘录</span><span class="text-ey">' + escapeHtml(mapped.evidenceCell) + '</span></div></div>'
        : '<p class="text-xs text-amber-400">未自动定位目标单元格，请按问题描述人工匹配。</p>';
      var workpaperPage = v.pages || '';
      var displayQuestionNo = revenueDisplayValue(v, 'question_no', ruleId);
      var displayQuestionDescription = revenueDisplayValue(v, 'question_description', ruleId);
      var workpaperLocation = v.workpaper_section || (v.workpaper_row ? '第 ' + v.workpaper_row + ' 行' : '');
      var poSubjectHtml = v.po_name
        ? '<div class="bg-blue-950/30 border border-blue-900/60 rounded-lg p-3"><p class="text-xs text-blue-300 mb-1">本表分析对象</p><p class="text-sm text-white">PO#' + escapeHtml(v.po_no || '') + ' · ' + escapeHtml(v.po_name) + '</p>' + (v.po_components ? '<p class="text-xs text-gray-400 mt-1">' + escapeHtml(v.po_components) + '</p>' : '') + '</div>'
        : '';
      return '<div class="card p-4 space-y-4 border-2 border-gray-800">' +
        '<div><div class="flex items-center gap-2 flex-wrap mb-2"><span class="text-xs text-ey">' + escapeHtml(v.workpaper_sheet || '') + '</span><span class="text-xs text-gray-500">' + escapeHtml(displayQuestionNo || '') + '</span><span class="text-xs text-gray-600">底稿位置：' + escapeHtml(workpaperLocation || '待核对') + '</span></div>' +
        '<p class="text-sm text-white leading-relaxed">' + escapeHtml(displayQuestionDescription || '') + '</p></div>' +
        poSubjectHtml +
        '<div class="grid md:grid-cols-3 gap-3"><div class="bg-black/50 border border-gray-800 rounded-lg p-3"><p class="text-xs text-gray-500 mb-1">建议回答</p><p class="text-sm text-white">' + escapeHtml(v.suggested_answer || '—') + '</p></div>' +
        '<div class="bg-black/50 border border-gray-800 rounded-lg p-3"><p class="text-xs text-gray-500 mb-1">主问题填入状态</p><p class="text-sm ' + (v.fill_readiness === '可直接填入' ? 'text-emerald-400' : (v.fill_readiness === '资料不足' ? 'text-red-400' : 'text-amber-400')) + '">' + escapeHtml(v.fill_readiness || '资料不足') + '</p></div>' +
        '<div class="bg-black/50 border border-gray-800 rounded-lg p-3"><p class="text-xs text-gray-500 mb-1">置信度 / 复核状态</p><p class="text-sm text-gray-300">' + escapeHtml(v.confidence || '—') + ' · ' + escapeHtml(v.review_status || '需人工复核') + '</p></div></div>' +
        '<div class="grid md:grid-cols-2 gap-3"><div><h4 class="text-sm font-medium text-gray-300 mb-2">合同依据</h4><p class="text-sm text-gray-300 leading-relaxed">' + escapeHtml(v.contract_basis || '—') + '</p></div>' +
        '<div><h4 class="text-sm font-medium text-gray-300 mb-2">SOP定位</h4><p class="text-sm text-gray-300 leading-relaxed">' + escapeHtml(v.sop_basis || '—') + '</p></div></div>' +
        '<div><h4 class="text-sm font-medium text-gray-300 mb-2">意见 / 回答的理由</h4><p class="text-sm text-gray-300 leading-relaxed">' + escapeHtml(v.answer_reason || '—') + '</p></div>' +
        '<div><h4 class="text-sm font-medium text-gray-300 mb-2">合同条款摘录</h4><div class="text-sm text-gray-200 leading-relaxed bg-black/50 border border-gray-800 rounded-lg p-3 max-h-48 overflow-y-auto ap-scroll">' + escapeHtml(v.contract_excerpt || '—') + '</div></div>' +
        '<div><h4 class="text-sm font-medium text-gray-300 mb-2">来源文件</h4><p class="text-sm text-gray-400 leading-relaxed">' + escapeHtml(v.source_documents || '主合同') + '</p></div>' +
        '<div class="grid md:grid-cols-3 gap-3"><div><h4 class="text-sm font-medium text-gray-300 mb-2">附表或判断尚缺资料</h4><p class="text-sm text-amber-300 leading-relaxed">' + escapeHtml(v.missing_information || '无') + '</p></div>' +
        '<div><h4 class="text-sm font-medium text-gray-300 mb-2">触发附表</h4><p class="text-sm text-gray-300 leading-relaxed">' + escapeHtml(v.triggered_sheet || '无') + '</p></div>' +
        '<div><h4 class="text-sm font-medium text-gray-300 mb-2">附表完成状态</h4><p class="text-sm text-gray-300 leading-relaxed">' + escapeHtml(v.appendix_status || '未触发') + '</p></div></div>' +
        '<div><h4 class="text-sm font-medium text-gray-300 mb-2">支持证据描述</h4><p class="text-sm text-gray-400 leading-relaxed">' + escapeHtml(v.supporting_evidence || '—') + '</p></div>' +
        '<div><p class="text-xs text-gray-500 mb-2">目标单元格</p>' + targetHtml + '</div>' +
        '<div class="flex flex-wrap gap-2 pt-2 border-t border-gray-800">' +
        evidenceLinksHtml(v, false) +
        '<button type="button" onclick="toggleReviewed(\'' + v.id + '\')" class="btn-outline btn-sm px-3 py-1.5 rounded-lg text-xs">' + (v.reviewed ? '取消复核标记' : '标记已复核') + '</button></div></div>';
    }
    var viewFs = fieldsForWorkView(ruleId, fieldSetId || v.fieldSetId);
    var pk = pageKey(ruleId);
    var excerptF = viewFs.find(function (f) { return /excerpt|原文/i.test(f.key); });
    var auditF = viewFs.find(function (f) { return /auditor|审计|提示/i.test(f.key); });
    var pageVal = pk ? v[pk] : '';
    var html = '<div class="card p-4 space-y-4 border-2 border-gray-800">';

    if (excerptF && v[excerptF.key]) {
      html += '<div><h4 class="text-sm font-medium text-gray-300 mb-2">原文摘录</h4>' +
        '<div class="text-sm text-gray-200 leading-relaxed bg-black/50 border border-gray-800 rounded-lg p-3 max-h-48 overflow-y-auto ap-scroll">' +
        escapeHtml(v[excerptF.key]) + '</div></div>';
    }

    if (auditF && v[auditF.key]) {
      html += '<div><h4 class="text-sm font-medium text-ey mb-2">审计提示</h4>' +
        '<p class="text-sm text-gray-300 leading-relaxed">' + escapeHtml(v[auditF.key]) + '</p></div>';
    }

    viewFs.forEach(function (f) {
      if (f.key === (excerptF && excerptF.key) || f.key === (auditF && auditF.key)) return;
      if (isLongField(f.key)) return;
      html += '<div class="flex gap-2 text-xs"><span class="text-gray-500 shrink-0">' + escapeHtml(f.label) + '：</span>' +
        '<span class="text-gray-300">' + escapeHtml(v[f.key] || '—') + '</span></div>';
    });

    html += '<div class="flex flex-wrap gap-2 pt-2 border-t border-gray-800">';
    if (pageVal) {
      html += '<button type="button" title="' + htmlAttributeValue((v.source_documents || '当前合同') + ' ' + pageVal) + '" onclick="jumpToEvidence(\'' + inlineJsValue(v.contractId || '') + '\',\'' + inlineJsValue(v.source_documents || '') + '\',\'' + inlineJsValue(pageVal) + '\',\'\',\'' + inlineJsValue(v.id || '') + '\')" class="btn-outline btn-sm px-3 py-1.5 rounded-lg text-xs">' + escapeHtml(compactEvidencePageText(pageVal)) + '</button>';
    }
    html += '<button type="button" onclick="toggleReviewed(\'' + v.id + '\')" class="btn-outline btn-sm px-3 py-1.5 rounded-lg text-xs">' + (v.reviewed ? '取消复核标记' : '标记已复核') + '</button>' +
      '</div></div>';
    return html;
  }

  global.workpaperHtml = function (contractId) {
    var c = gc(contractId);
    if (!c) return '';
    var ruleId = activeRuleId;
    var sets = FieldSet.listFieldSets(contractId, ruleId);
    if (typeof activeFieldSetId === 'undefined' || !activeFieldSetId || !sets.some(function (s) { return s.id === activeFieldSetId; })) {
      activeFieldSetId = sets.length ? sets[0].id : null;
    }
    var fsId = activeFieldSetId;
    var rawVs = fsId ? FieldSet.gvFieldSet(contractId, ruleId, fsId) : gvRule(contractId, ruleId);
    var vs = visibleWorkpaperItems(ruleId, rawVs);
    var q = (typeof workFilterText !== 'undefined' ? workFilterText : '').trim();
    var filtered = vs.filter(function (v) { return workRowMatchesFilter(v, ruleId, q, fsId); });
    var selId = typeof selectedWorkRowId !== 'undefined' ? selectedWorkRowId : null;
    if (selId && !filtered.some(function (v) { return v.id === selId; })) selId = filtered.length ? filtered[0].id : null;
    selectedWorkRowId = selId;

    var cols = getSummaryFields(ruleId, fsId, contractId);
    var head = cols.map(function (f) {
      return '<th class="text-left p-2 border-b border-gray-800 text-xs text-gray-400 whitespace-nowrap">' + escapeHtml(f.label) + '</th>';
    }).join('') + '<th class="text-left p-2 border-b border-gray-800 text-xs text-gray-400 whitespace-nowrap">复核状态</th>';

    var rows = filtered.length
      ? filtered.map(function (v, i) { return workSummaryRowHtml(v, i, ruleId, v.id === selId, fsId); }).join('')
      : '<tr><td colspan="' + (cols.length + 1) + '" class="p-6 text-center text-gray-500 text-sm">无匹配结果</td></tr>';

    var versionSel = '';
    if (sets.length > 0) {
      versionSel = '<span class="text-sm text-gray-400">底稿版本</span>' +
        '<select onchange="switchWorkFieldSet(this.value)" class="bg-black border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white max-w-[280px]">' +
        sets.map(function (s) {
          var visibleCount = isRevenueWorkpaperRule(ruleId)
            ? visibleWorkpaperItems(ruleId, FieldSet.gvFieldSet(contractId, ruleId, s.id)).length
            : s.count;
          return '<option value="' + escapeHtml(s.id) + '"' + (s.id === fsId ? ' selected' : '') + '>' +
            escapeHtml(s.label) + '（' + visibleCount + '条）</option>';
        }).join('') + '</select>';
    }

    return '<div class="space-y-4">' +
      '<div class="card p-3 space-y-3">' +
      '<div class="flex flex-wrap items-center justify-between gap-3">' +
      '<div class="flex flex-wrap items-center gap-2">' +
      '<span class="text-sm text-gray-400">当前模板</span>' +
      '<select onchange="switchContractRule(this.value)" class="bg-black border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white">' +
      ruleSelectOptionsHtml(ruleId) + '</select>' +
      versionSel +
      '<span class="text-xs px-2 py-0.5 rounded-full bg-gray-800 text-gray-400">' + vs.length + ' 条结果</span>' +
      (sets.length > 1 ? '<span class="text-xs text-gray-600">共 ' + sets.length + ' 套底稿</span>' : '') +
      '</div>' +
      '<div class="flex gap-2">' +
      '<button type="button" onclick="exportToExcel(\'' + contractId + '\',false,\'' + ruleId + '\',false,\'' + (fsId || '') + '\')" class="btn-outline btn-sm px-3 py-1.5 rounded-lg text-xs" title="导出当前版本底稿为 Excel">导出当前底稿</button>' +
      '<button type="button" onclick="exportToExcel(\'' + contractId + '\',false,null,true)" class="btn-outline btn-sm px-3 py-1.5 rounded-lg text-xs" title="导出本文件所有模板/版本的提取结果为 Excel">导出全部底稿</button>' +
      '</div></div>' +
      '<div class="flex gap-2 items-center">' +
      '<input type="search" id="workFilterInput" value="' + escapeHtml(q) + '" oninput="onWorkFilterInput(this.value)" placeholder="筛选：输入关键词定位条款…" class="flex-1 bg-black border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-gray-600">' +
      '<span class="text-xs text-gray-600 shrink-0">' + filtered.length + '/' + vs.length + '</span></div></div>' +
      '<div class="grid 2xl:grid-cols-[minmax(0,1.15fr)_minmax(280px,0.85fr)] gap-4 items-start">' +
      '<div class="card overflow-hidden"><div class="px-3 py-2 border-b border-gray-800 bg-gray-900"><p class="text-sm font-medium text-white">条目列表</p></div><div class="overflow-x-auto ap-scroll"><table class="w-full text-sm"><thead class="bg-gray-900"><tr>' + head + '</tr></thead><tbody>' + rows + '</tbody></table></div></div>' +
      '<div class="2xl:sticky 2xl:top-0" id="workDetailPanel">' + workRowDetailHtml(selId, ruleId, fsId) + '</div></div>' +
      (isRevenueWorkpaperRule(ruleId) ? revenueWorkpaperPanelHtml(contractId, rawVs.length > 0, fsId, 'work') : '') +
      '</div>';
  };

  global.switchWorkFieldSet = function (fieldSetId) {
    activeFieldSetId = fieldSetId || null;
    selectedWorkRowId = null;
    render();
  };

  global.selectWorkRow = function (itemId) {
    selectedWorkRowId = itemId;
    document.querySelectorAll('.work-row').forEach(function (tr) {
      tr.classList.remove('work-row-active');
    });
    var active = document.querySelector('.work-row[data-id="' + itemId + '"]');
    if (active) active.classList.add('work-row-active');
    var panel = document.getElementById('workDetailPanel');
    if (panel) panel.innerHTML = workRowDetailHtml(itemId, activeRuleId, activeFieldSetId);
  };

  global.toggleReviewed = function (itemId) {
    var item = V.find(function (x) { return x.id === itemId; });
    if (!item) return;
    item.reviewed = !item.reviewed;
    item.updatedAt = new Date().toISOString();
    var contract = typeof gc === 'function' ? gc(item.contractId) : null;
    if (contract && typeof touchProject === 'function') touchProject(contract.pid);
    save();
    var panel = document.getElementById('workDetailPanel');
    if (panel && selectedWorkRowId === itemId) panel.innerHTML = workRowDetailHtml(itemId, activeRuleId, activeFieldSetId);
    document.querySelectorAll('.work-row[data-id="' + itemId + '"]').forEach(function (tr) {
      var btn = tr.querySelector('td:last-child button');
      if (btn) {
        btn.textContent = item.reviewed ? '已复核' : '待复核';
        btn.className = item.reviewed ? 'text-emerald-400' : 'text-gray-500 hover:text-gray-300';
      }
    });
  };

  var workFilterTimer = null;
  global.onWorkFilterInput = function (val) {
    workFilterText = val;
    if (workFilterTimer) clearTimeout(workFilterTimer);
    workFilterTimer = setTimeout(function () { render(); }, 200);
  };

  global.rulePanelHtml = function (contractId) {
    return fileFlowCardHtml(contractId);
  };

  global.ruleSelectOptionsHtml = function (selectedId, includeEmpty) {
    var html = includeEmpty ? '<option value=""' + (!selectedId ? ' selected' : '') + '>不设置（上传后AI识别）</option>' : '';
    RuleEngine.getAllSelectableRules().forEach(function (r) {
      html += '<option value="' + r.id + '"' + (selectedId === r.id ? ' selected' : '') + '>' + escapeHtml(r.name) + '</option>';
    });
    return html;
  };

  global.contractListMetaHtml = function (c, options) {
    options = options || {};
    var cv = gv(c.id).length;
    var rules = getAppliedRuleIds(c.id).length;
    var rid = getContractRuleId(c);
    var tag = c.isScanned
      ? (cv > 0
        ? '<span class="text-xs px-2 py-0.5 rounded-full bg-emerald-900 text-emerald-400 ml-1">已提取' + cv + '条/' + rules + '模板</span>'
        : '<span class="text-xs px-2 py-0.5 rounded-full bg-purple-900 text-purple-400 ml-1">扫描件(' + c.text.length + '字)</span>')
      : (c.text && c.text.length > 0
        ? '<span class="text-xs px-2 py-0.5 rounded-full bg-blue-900 text-blue-400 ml-1">' + c.text.length + '字' + (cv > 0 ? '|已提' + cv + '条' : '') + '</span>'
        : '<span class="text-xs px-2 py-0.5 rounded-full bg-gray-700 text-gray-300 ml-1">处理中</span>');
    var conf = c.detectedConfidence;
    var aiTag = '';
    if (c.detectedRuleId || c.docLabel) {
      var confTxt = conf === 'high' ? '高' : conf === 'medium' ? '中' : '低';
      var confClr = conf === 'high' ? 'text-emerald-400' : conf === 'medium' ? 'text-amber-400' : 'text-red-400';
      aiTag = '<span class="text-xs ' + confClr + ' ml-1">AI:' + escapeHtml(c.docLabel || RuleEngine.getRuleShortName(rid)) + '(' + confTxt + ')' +
        (c.ruleConfirmed ? '·已确认' : '·待确认') + '</span>';
    }
    var confirmUi = c.ruleConfirmed
      ? '<span class="text-xs text-emerald-400 px-2 py-0.5 rounded bg-emerald-900/40 border border-emerald-800">✓ 模板已确认</span>'
      : '<button type="button" onclick="confirmDocRule(\'' + c.id + '\',document.getElementById(\'crs_' + c.id + '\').value)" class="btn-outline btn-sm px-2 py-0.5 rounded text-xs">确认模板</button>';
    var reBtn = (c.text && c.text.length > 0)
      ? (cv > 0
        ? '<button type="button" onclick="quickReExtract(\'' + c.id + '\')" class="text-xs text-gray-400 hover:text-ey px-2 py-0.5 rounded hover:bg-gray-800">重新提取</button>'
        : '<button type="button" onclick="quickStartExtract(\'' + c.id + '\')" class="text-xs text-ey hover:underline px-2 py-0.5">开始提取</button>')
      : '';
    var association = fileAssociationSummary(c.id);
    var associationUi = options.hideAssociation ? '' : '<button type="button" onclick="openFileAssociationModal(' + inlineJsArg(c.id) + ')" class="text-xs text-gray-400 hover:text-white px-2 py-0.5 rounded hover:bg-gray-800">' + (association.count > 0 ? '管理资料' : '关联资料') + '</button>' +
      (association.count > 0 && !options.grouped ? '<span class="text-xs text-emerald-400 px-1">已关联' + association.count + '份</span>' : '');
    var ruleSel = '<div class="mt-2 flex flex-wrap gap-2 items-center" onclick="event.stopPropagation()">' +
      '<span class="text-xs text-gray-500">模板</span>' +
      '<select id="crs_' + c.id + '" onchange="onListTemplateChange(\'' + c.id + '\',this.value)" class="bg-black border border-gray-700 rounded px-2 py-0.5 text-xs text-white max-w-[180px]">' +
      ruleSelectOptionsHtml(rid) + '</select>' +
      confirmUi + reBtn +
      (cv > 0 ? '<button type="button" onclick="nav(\'work\',{cid:\'' + c.id + '\',ruleId:\'' + rid + '\'})" class="text-xs text-gray-400 hover:text-white px-2 py-0.5 rounded hover:bg-gray-800">查看底稿</button>' : '') +
      associationUi +
      '</div>';
    return tag + aiTag + ruleSel;
  };

  global.onListTemplateChange = function (contractId, ruleId) {
    setContractDefaultRule(contractId, ruleId);
  };

  global.quickStartExtract = function (contractId) {
    cid = contractId;
    var c = gc(contractId);
    if (!c) return;
    activeRuleId = getContractRuleId(c);
    nav('cont', { cid: contractId, ruleId: activeRuleId });
    setTimeout(function () { if (typeof re === 'function') re(); }, 400);
  };

  global.quickReExtract = function (contractId) {
    cid = contractId;
    var c = gc(contractId);
    if (!c) return;
    activeRuleId = getContractRuleId(c);
    nav('cont', { cid: contractId, ruleId: activeRuleId });
    setTimeout(function () { if (typeof re === 'function') re(); }, 400);
  };

  global.openBatchExtractModal = function () {
    if (!ok()) { alert('请先配置AI API'); nav('cfg'); return; }
    var cbs = document.querySelectorAll('.contract-cb:checked');
    if (cbs.length === 0) { alert('请先勾选需要提取的文件'); return; }
    var root = ensureModalRoot();
    root.innerHTML = '<div class="modal-backdrop fixed inset-0 bg-black/70 flex items-center justify-center" onclick="if(event.target===this)cm()">' +
      '<div class="bg-gray-900 border border-gray-700 rounded-xl p-5 w-full max-w-md mx-4 shadow-2xl" onclick="event.stopPropagation()">' +
      '<h3 class="font-semibold text-white mb-3">开始提取 · 选择模板</h3>' +
      '<div class="space-y-3"><div><label class="text-xs text-gray-400 block mb-1">提取模板</label>' +
      '<select id="batchRuleSel" class="w-full bg-black border border-gray-700 rounded-lg px-3 py-2 text-sm text-white" onchange="refreshBatchFieldHint()">' +
      ruleSelectOptionsHtml(batchRuleId) + '</select></div>' +
      '<label class="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">' +
      '<input id="batchSkipExisting" type="checkbox" class="w-4 h-4 rounded border-gray-700 bg-black text-ey" checked>' +
      '跳过已有相同字段组合底稿的文件</label>' +
      '<p id="batchFieldHint" class="text-xs text-gray-600">下一步将勾选要提取的字段（页码必选）</p>' +
      '<div class="flex gap-2"><button type="button" onclick="cm()" class="flex-1 border border-gray-700 py-2 rounded-lg text-sm text-gray-400">取消</button>' +
      '<button type="button" onclick="runBatchExtract()" class="flex-1 btn btn-sm">下一步：选字段</button></div></div></div></div>';
  };

  global.refreshBatchFieldHint = function () {};

  global.runBatchExtract = function () {
    var sel = document.getElementById('batchRuleSel');
    var skipEl = document.getElementById('batchSkipExisting');
    if (!sel) return;
    batchRuleId = sel.value;
    var skipExisting = skipEl ? skipEl.checked : true;
    var cbs = document.querySelectorAll('.contract-cb:checked');
    var selectedIds = Array.from(cbs).map(function (cb) { return cb.value; });
    openFieldSelectModal({
      mode: 'batch',
      ruleId: batchRuleId,
      projectId: pid,
      selectedIds: selectedIds,
      skipExisting: skipExisting
    });
  };

  global.runBatchExtractWithFields = function (fieldKeys, ctx) {
    ctx = ctx || {};
    var ruleId = ctx.ruleId || batchRuleId;
    fieldKeys = FieldSet.ensurePageInKeys(ruleId, fieldKeys);
    var fsId = FieldSet.fieldSetIdOf(fieldKeys);
    FieldSet.setProjectFieldPrefs(pid, ruleId, fieldKeys);
    var selectedIds = ctx.selectedIds || [];
    var skipExisting = ctx.skipExisting !== false;
    var cs = Ct.filter(function (c) {
      if (selectedIds.indexOf(c.id) < 0 || !c.text || !c.text.length) return false;
      if (skipExisting && FieldSet.gvFieldSet(c.id, ruleId, fsId).length > 0) return false;
      return true;
    });
    if (cs.length === 0) { alert('没有需要提取的文件（可能已全部有该字段组合的底稿）'); return; }
    var versionPreview = FieldSet.formatVersionLabel(ruleId, fieldKeys, new Date().toISOString());
    if (!confirm('确认用「' + RuleEngine.getRuleName(ruleId) + '」批量提取 ' + cs.length + ' 份？\n字段组合：' + fieldKeys.length + ' 个\n版本名示例：' + versionPreview)) return;
    var queue = cs.map(function (c) {
      return { contractId: c.id, text: c.text, name: c.file, ruleId: ruleId, fieldKeys: fieldKeys, fieldSetId: fsId };
    });
    if (typeof taskRunner !== 'undefined') taskRunner.start('batch', '批量提取', queue.length);
    function finishBatch(done, stopped) {
      var okN = done.filter(function (r) { return r.success; }).length;
      if (typeof taskRunner !== 'undefined') {
        taskRunner.finish(stopped ? '已停止' : '批量提取完成', okN + '/' + queue.length);
      }
      alert((stopped ? '批量提取已停止。' : '批量提取完成！') + okN + '/' + queue.length);
      save(); render();
    }
    function processQueue(todo, done) {
      if ((typeof taskRunner !== 'undefined' && taskRunner.isStopped()) || todo.length === 0) {
        finishBatch(done, typeof taskRunner !== 'undefined' && taskRunner.isStopped());
        return;
      }
      var batch = todo.slice(0, BATCH_CONCURRENCY);
      var rest = todo.slice(BATCH_CONCURRENCY);
      Promise.all(batch.map(function (item) {
        if (typeof taskRunner !== 'undefined' && taskRunner.isStopped()) {
          return Promise.resolve({ success: false, stopped: true });
        }
        var extractAt = new Date().toISOString();
        var versionLabel = FieldSet.formatVersionLabel(item.ruleId, item.fieldKeys, extractAt);
        delete extractCache[cacheKeyFor(item.contractId, item.ruleId, item.fieldSetId)];
        return aiExtract(item.text, function (st) {
          if (typeof taskRunner !== 'undefined') {
            taskRunner.update(item.name + ' · ' + (typeof st === 'string' ? st : st.msg), done.length + 1 + '/' + queue.length);
          }
          updateLog(item.contractId, 'AI条款提取中[' + RuleEngine.getRuleShortName(item.ruleId) + ']', typeof st === 'string' ? st : st.msg, 'info');
        }, item.contractId, item.ruleId, item.fieldKeys).then(function (result) {
          FieldSet.replaceFieldSetResults(item.contractId, item.ruleId, item.fieldSetId, result, {
            keys: item.fieldKeys,
            extractAt: extractAt,
            label: versionLabel
          });
          var cc = gc(item.contractId); if (cc) cc.status = 'extracted';
          addLog(item.contractId, item.name, '提取完成', versionLabel + ' ' + result.length + '条', 'done');
          return { success: true, count: result.length };
        }).catch(function (err) {
          if (typeof isTaskStoppedErr === 'function' && isTaskStoppedErr(err)) {
            return { success: false, stopped: true };
          }
          var friendly = typeof friendlyAiError === 'function' ? friendlyAiError(err) : String(err.message || err);
          addLog(item.contractId, item.name, '❌ 提取失败', friendly.substring(0, 120), 'error');
          return { success: false, error: friendly };
        });
      })).then(function (results) {
        save(); render();
        if (typeof taskRunner !== 'undefined') taskRunner.tick(batch.length);
        if (typeof taskRunner !== 'undefined' && taskRunner.isStopped()) {
          finishBatch(done.concat(results), true);
          return;
        }
        setTimeout(function () { processQueue(rest, done.concat(results)); }, 500);
      });
    }
    processQueue(queue, []);
  };

  global.buildExportRows = function (cids, ruleId, allRules, fieldSetId) {
    var rowsBySheet = {};
    cids.forEach(function (id) {
      var c = gc(id);
      if (!c) return;
      var ruleIds = allRules ? getAppliedRuleIds(id) : [ruleId || activeRuleId];
      if (allRules && ruleIds.length === 0) ruleIds = [getContractRuleId(c)];
      ruleIds.forEach(function (rid) {
        var sets = FieldSet.listFieldSets(id, rid);
        if (!sets.length) return;
        var exportSets = allRules
          ? sets
          : sets.filter(function (s) { return !fieldSetId || s.id === fieldSetId; });
        if (!allRules && fieldSetId && exportSets.length === 0) {
          exportSets = sets.filter(function (s) { return s.id === fieldSetId; });
        }
        if (!allRules && !fieldSetId) exportSets = sets.slice(0, 1);
        exportSets.forEach(function (set) {
          var sheetName;
          if (allRules || exportSets.length > 1) {
            sheetName = (RuleEngine.getRuleShortName(rid) || rid) + '_' + (set.keys || []).length + '字段';
            sheetName = sheetName.substring(0, 31);
          } else {
            sheetName = '底稿';
          }
          if (!rowsBySheet[sheetName]) rowsBySheet[sheetName] = { ruleId: rid, rows: [] };
          var fs = FieldSet.fieldsForKeys(rid, set.keys);
          visibleWorkpaperItems(rid, FieldSet.gvFieldSet(id, rid, set.id)).forEach(function (v) {
            var row = {
              '合同名称': c.file,
              '提取模板': RuleEngine.getRuleName(rid),
              '底稿版本': v.versionLabel || set.label || ''
            };
            fs.forEach(function (f) { row[f.label] = revenueDisplayValue(v, f.key, rid) || ''; });
            rowsBySheet[sheetName].rows.push(row);
          });
        });
      });
    });
    return rowsBySheet;
  };

})(window);
