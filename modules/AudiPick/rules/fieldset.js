// 项目级字段勾选 + 多套底稿（fieldSet）
(function (global) {
  function fieldSetIdOf(keys) {
    return (keys || []).slice().sort().join('|') || '__empty__';
  }

  function ensurePageInKeys(ruleId, keys) {
    var pk = typeof pageKey === 'function' ? pageKey(ruleId) : RuleEngine.pageKeyForRule(ruleId);
    var list = (keys || []).slice();
    if (pk && list.indexOf(pk) < 0) list.unshift(pk);
    // 去重并保持模板字段顺序
    var all = RuleEngine.getFieldsForRule(ruleId);
    var ordered = [];
    all.forEach(function (f) {
      if (list.indexOf(f.key) >= 0) ordered.push(f.key);
    });
    list.forEach(function (k) {
      if (ordered.indexOf(k) < 0) ordered.push(k);
    });
    return ordered;
  }

  function formatExtractTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    var hh = String(d.getHours()).padStart(2, '0');
    var mi = String(d.getMinutes()).padStart(2, '0');
    return mm + '-' + dd + ' ' + hh + ':' + mi;
  }

  function formatVersionLabel(ruleId, keys, extractAt) {
    var short = RuleEngine.getRuleShortName(ruleId);
    var n = (keys || []).length;
    var t = formatExtractTime(extractAt);
    return short + ' · ' + n + '字段' + (t ? ' · ' + t : '');
  }

  function getProjectFieldPrefs(projectId, ruleId) {
    var p = typeof gp === 'function' ? gp(projectId) : null;
    if (!p || !p.fieldPrefs || !p.fieldPrefs[ruleId]) return null;
    return ensurePageInKeys(ruleId, p.fieldPrefs[ruleId]);
  }

  function setProjectFieldPrefs(projectId, ruleId, keys) {
    var p = typeof gp === 'function' ? gp(projectId) : null;
    if (!p) return;
    if (!p.fieldPrefs) p.fieldPrefs = {};
    p.fieldPrefs[ruleId] = ensurePageInKeys(ruleId, keys);
    if (typeof save === 'function') save();
  }

  function defaultFieldKeys(ruleId) {
    return RuleEngine.getFieldsForRule(ruleId).map(function (f) { return f.key; });
  }

  function resolveFieldKeys(projectId, ruleId) {
    var prefs = getProjectFieldPrefs(projectId, ruleId);
    if (prefs && prefs.length) {
      if (ruleId === 'revenue_workpaper') {
        defaultFieldKeys(ruleId).forEach(function (key) {
          if (prefs.indexOf(key) < 0) prefs.push(key);
        });
        return ensurePageInKeys(ruleId, prefs);
      }
      return prefs;
    }
    return defaultFieldKeys(ruleId);
  }

  function migrateItemFieldSet(v) {
    if (!v || v.fieldSetId) return v;
    var rid = v.ruleId || 'loan_covenant';
    var keys = defaultFieldKeys(rid);
    v.fieldKeys = keys;
    v.fieldSetId = fieldSetIdOf(keys);
    v.versionLabel = RuleEngine.getRuleShortName(rid) + ' · 全字段（历史）';
    if (!v.extractAt) v.extractAt = '';
    return v;
  }

  function migrateAllFieldSets() {
    if (typeof V === 'undefined' || !V) return;
    V.forEach(migrateItemFieldSet);
  }

  function listFieldSets(contractId, ruleId) {
    ruleId = ruleId || (typeof activeRuleId !== 'undefined' ? activeRuleId : null);
    var map = {};
    V.filter(function (x) {
      return x.contractId === contractId && (x.ruleId || 'loan_covenant') === ruleId;
    }).forEach(function (v) {
      migrateItemFieldSet(v);
      var id = v.fieldSetId;
      if (!map[id]) {
        map[id] = {
          id: id,
          ruleId: ruleId,
          keys: v.fieldKeys || defaultFieldKeys(ruleId),
          label: v.versionLabel || formatVersionLabel(ruleId, v.fieldKeys, v.extractAt),
          extractAt: v.extractAt || '',
          count: 0
        };
      }
      map[id].count++;
      if (v.extractAt && (!map[id].extractAt || v.extractAt > map[id].extractAt)) {
        map[id].extractAt = v.extractAt;
        map[id].label = v.versionLabel || formatVersionLabel(ruleId, map[id].keys, v.extractAt);
      }
    });
    return Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) {
      if (a.extractAt && b.extractAt) return a.extractAt < b.extractAt ? 1 : -1;
      if (a.extractAt) return -1;
      if (b.extractAt) return 1;
      return 0;
    });
  }

  function latestFieldSetId(contractId, ruleId) {
    var sets = listFieldSets(contractId, ruleId);
    return sets.length ? sets[0].id : null;
  }

  function gvFieldSet(contractId, ruleId, fieldSetId) {
    ruleId = ruleId || activeRuleId;
    return V.filter(function (x) {
      migrateItemFieldSet(x);
      return x.contractId === contractId &&
        (x.ruleId || 'loan_covenant') === ruleId &&
        x.fieldSetId === fieldSetId;
    });
  }

  function fieldsForKeys(ruleId, keys) {
    var all = RuleEngine.getFieldsForRule(ruleId);
    var set = {};
    (keys || []).forEach(function (k) { set[k] = true; });
    return all.filter(function (f) { return set[f.key]; });
  }

  function filterPromptByFields(prompt, allowedKeys) {
    if (!prompt || !allowedKeys || !allowedKeys.length) return prompt;
    var start = prompt.indexOf('【字段定义】');
    if (start < 0) return prompt;
    var rest = prompt.slice(start + 5);
    var endM = rest.match(/\n【[^】]+】/);
    var blockEnd = endM ? endM.index : rest.length;
    var block = rest.slice(0, blockEnd);
    var after = rest.slice(blockEnd);
    var allow = {};
    allowedKeys.forEach(function (k) { allow[k] = true; });
    var lines = block.split(/\r?\n/).filter(function (line) {
      var m = line.match(/^\s*([A-Za-z_][\w\u4e00-\u9fa5]*)\s*[:：]/);
      if (!m) return true; // 保留空行/说明
      return !!allow[m[1].trim()];
    });
    return prompt.slice(0, start) + '【字段定义】\n' + lines.join('\n') + after;
  }

  function replaceFieldSetResults(contractId, ruleId, fieldSetId, items, meta) {
    if (ruleId === 'revenue_workpaper' && global.RevenueWorkpaper) {
      items = global.RevenueWorkpaper.normalizeResults(items);
    }
    // 就地更新全局 V（避免跨脚本 let 重绑定问题）
    for (var i = V.length - 1; i >= 0; i--) {
      migrateItemFieldSet(V[i]);
      if (V[i].contractId === contractId &&
        (V[i].ruleId || 'loan_covenant') === ruleId &&
        V[i].fieldSetId === fieldSetId) {
        V.splice(i, 1);
      }
    }
    items.forEach(function (r) {
      r.contractId = contractId;
      r.ruleId = ruleId;
      r.ruleVersion = (RuleEngine.getRule(ruleId) || {}).version || '1.0';
      r.fieldKeys = meta.keys;
      r.fieldSetId = fieldSetId;
      r.extractAt = meta.extractAt;
      r.versionLabel = meta.label;
      V.push(r);
    });
  }

  global.FieldSet = {
    fieldSetIdOf: fieldSetIdOf,
    ensurePageInKeys: ensurePageInKeys,
    formatVersionLabel: formatVersionLabel,
    formatExtractTime: formatExtractTime,
    getProjectFieldPrefs: getProjectFieldPrefs,
    setProjectFieldPrefs: setProjectFieldPrefs,
    defaultFieldKeys: defaultFieldKeys,
    resolveFieldKeys: resolveFieldKeys,
    migrateItemFieldSet: migrateItemFieldSet,
    migrateAllFieldSets: migrateAllFieldSets,
    listFieldSets: listFieldSets,
    latestFieldSetId: latestFieldSetId,
    gvFieldSet: gvFieldSet,
    fieldsForKeys: fieldsForKeys,
    filterPromptByFields: filterPromptByFields,
    replaceFieldSetResults: replaceFieldSetResults
  };
})(window);
