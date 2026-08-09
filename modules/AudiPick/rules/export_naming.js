(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ExportNaming = api;
})(typeof window !== 'undefined' ? window : this, function () {
  function localDateStamp(value) {
    var date = value instanceof Date ? value : new Date(value || Date.now());
    if (!isFinite(date.getTime())) date = new Date();
    function pad(number) { return String(number).padStart(2, '0'); }
    return String(date.getFullYear()) + pad(date.getMonth() + 1) + pad(date.getDate());
  }

  function stripExtension(value) {
    return String(value || '').replace(/\.[^.\\/]+$/, '');
  }

  function sanitizePart(value) {
    return String(value || '')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/[. ]+$/g, '')
      .trim();
  }

  function sanitizeFileName(value) {
    var raw = String(value || '').trim().replace(/\.xlsx$/i, '');
    var name = sanitizePart(raw).replace(/_+/g, '_');
    if (!name) name = 'AudiPick_导出结果';
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
    return name.substring(0, 180).replace(/[. ]+$/g, '') + '.xlsx';
  }

  function defaultExportName(options) {
    options = options || {};
    var parts = [];
    if (options.fileName) {
      parts.push(stripExtension(options.fileName));
    } else {
      if (options.projectName) parts.push(options.projectName);
      if (options.clientName && options.clientName !== options.projectName) parts.push(options.clientName);
      if (options.scopeLabel) parts.push(options.scopeLabel);
    }
    if (options.typeLabel) parts.push(options.typeLabel);
    parts.push(localDateStamp(options.date));
    return sanitizeFileName(parts.map(sanitizePart).filter(Boolean).join('_'));
  }

  return {
    localDateStamp: localDateStamp,
    stripExtension: stripExtension,
    sanitizeFileName: sanitizeFileName,
    defaultExportName: defaultExportName
  };
});
