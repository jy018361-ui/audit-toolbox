(function (global) {
  'use strict';

  var STORAGE_KEY = 'ap_theme';
  var DEFAULT_THEME = 'classic-dark';
  var themes = [
    {
      id: 'classic-dark', name: '经典黄黑', shortName: '黄黑',
      description: '当前经典深色界面',
      swatches: ['#050505', '#1A1A1A', '#FFCC00'],
      palette: { appBg: '#1A1A1A', surface: '#222222', text: '#F7F7F7', muted: '#C5CBD3', accent: '#FFCC00', accentText: '#171717', accentInk: '#FFCC00', sidebar: '#050505', sidebarText: '#F7F7F7', sidebarMuted: '#B8C0CB', sidebarAccent: '#FFCC00' }
    },
    {
      id: 'yellow-light', name: '明亮黄白', shortName: '黄白',
      description: '白色界面配黄色强调',
      swatches: ['#FFFFFF', '#F6F7F9', '#F2C200'],
      palette: { appBg: '#F6F7F9', surface: '#FFFFFF', text: '#171A1F', muted: '#4B5563', accent: '#F2C200', accentText: '#171717', accentInk: '#765E00', sidebar: '#FFFFFF', sidebarText: '#171A1F', sidebarMuted: '#4B5563', sidebarAccent: '#765E00' }
    },
    {
      id: 'blue-white', name: '专业蓝白', shortName: '蓝白',
      description: '沉稳蓝色导航与浅色内容区',
      swatches: ['#16324F', '#FFFFFF', '#1D4ED8'],
      palette: { appBg: '#F1F5F9', surface: '#FFFFFF', text: '#172033', muted: '#4B5563', accent: '#1D4ED8', accentText: '#FFFFFF', accentInk: '#1D4ED8', sidebar: '#16324F', sidebarText: '#FFFFFF', sidebarMuted: '#C7D5E4', sidebarAccent: '#93C5FD' }
    },
    {
      id: 'red-white', name: '利落红白', shortName: '红白',
      description: '白色底面配稳重红色',
      swatches: ['#FFFFFF', '#F7F7F8', '#C62828'],
      palette: { appBg: '#F7F7F8', surface: '#FFFFFF', text: '#25201F', muted: '#514B49', accent: '#C62828', accentText: '#FFFFFF', accentInk: '#B91C1C', sidebar: '#FFFFFF', sidebarText: '#25201F', sidebarMuted: '#5E5754', sidebarAccent: '#B91C1C' }
    },
    {
      id: 'yellow-blue', name: '醒目黄蓝', shortName: '黄蓝',
      description: '深蓝导航配明快黄色',
      swatches: ['#102A43', '#EAF1F7', '#F3C300'],
      palette: { appBg: '#EAF1F7', surface: '#FFFFFF', text: '#102A43', muted: '#425B70', accent: '#F3C300', accentText: '#102A43', accentInk: '#6B5600', sidebar: '#102A43', sidebarText: '#FFFFFF', sidebarMuted: '#D7E3EE', sidebarAccent: '#F3C300' }
    },
    {
      id: 'red-yellow-ivory', name: '红黄米白', shortName: '红黄米白',
      description: '暖米白底配砖红和金黄',
      swatches: ['#8F2424', '#FFFDF7', '#E0A800'],
      palette: { appBg: '#F6F0E2', surface: '#FFFDF7', text: '#3B2520', muted: '#62504A', accent: '#E0A800', accentText: '#2D1C16', accentInk: '#765700', sidebar: '#8F2424', sidebarText: '#FFFFFF', sidebarMuted: '#F4D6CE', sidebarAccent: '#FFD55A' }
    },
    {
      id: 'yellow-green', name: '清新黄绿', shortName: '黄绿',
      description: '墨绿导航配清爽黄绿色',
      swatches: ['#24513F', '#EEF4EA', '#F0C419'],
      palette: { appBg: '#EEF4EA', surface: '#FFFFFF', text: '#173A2B', muted: '#465E53', accent: '#F0C419', accentText: '#173A2B', accentInk: '#6B5600', sidebar: '#24513F', sidebarText: '#FFFFFF', sidebarMuted: '#D6E8DF', sidebarAccent: '#F0C419' }
    },
    {
      id: 'teal-dark', name: '深色青绿', shortName: '深色青绿',
      description: '深色底面配高对比青绿',
      swatches: ['#07110F', '#182422', '#2DD4BF'],
      palette: { appBg: '#101817', surface: '#182422', text: '#F1F8F6', muted: '#B9CBC6', accent: '#2DD4BF', accentText: '#062620', accentInk: '#5EEAD4', sidebar: '#07110F', sidebarText: '#F5FAF8', sidebarMuted: '#ADC3BD', sidebarAccent: '#5EEAD4' }
    }
  ];

  function getTheme(id) {
    return themes.find(function (theme) { return theme.id === id; }) || themes[0];
  }

  function savedThemeId() {
    try { return global.localStorage.getItem(STORAGE_KEY) || DEFAULT_THEME; } catch (e) { return DEFAULT_THEME; }
  }

  function current() {
    return getTheme((global.document && global.document.documentElement.getAttribute('data-theme')) || savedThemeId());
  }

  function updateIndicators() {
    var selected = current();
    var label = global.document && global.document.getElementById('theme-current-label');
    if (label) label.textContent = selected.shortName;
    if (!global.document) return;
    global.document.querySelectorAll('[data-theme-option]').forEach(function (button) {
      var active = button.getAttribute('data-theme-option') === selected.id;
      button.classList.toggle('theme-option-selected', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
      var state = button.querySelector('[data-theme-state]');
      if (state) state.textContent = active ? '已选择' : '选择';
    });
  }

  function apply(id, persist) {
    var selected = getTheme(id);
    if (global.document) {
      var root = global.document.documentElement;
      if (root.classList) root.classList.add('theme-applying');
      root.setAttribute('data-theme', selected.id);
      // 强制本次换肤直接落到最终颜色，避免按钮短暂保留上一主题的过渡色。
      if (typeof root.offsetWidth === 'number') void root.offsetWidth;
      if (root.classList) root.classList.remove('theme-applying');
    }
    if (persist !== false) {
      try { global.localStorage.setItem(STORAGE_KEY, selected.id); } catch (e) {}
    }
    updateIndicators();
    return selected;
  }

  function swatchesHtml(theme) {
    return theme.swatches.map(function (color) {
      return '<span class="theme-swatch" style="background:' + color + '"></span>';
    }).join('');
  }

  function optionHtml(theme) {
    var active = current().id === theme.id;
    return '<button type="button" data-theme-option="' + theme.id + '" aria-pressed="' + (active ? 'true' : 'false') + '" onclick="ThemeManager.apply(\'' + theme.id + '\')" class="theme-option' + (active ? ' theme-option-selected' : '') + '">' +
      '<span class="theme-option-swatches">' + swatchesHtml(theme) + '</span>' +
      '<span class="theme-option-copy"><strong>' + theme.name + '</strong><small>' + theme.description + '</small></span>' +
      '<span class="theme-option-state" data-theme-state>' + (active ? '已选择' : '选择') + '</span>' +
      '</button>';
  }

  function open() {
    if (!global.document) return;
    var root = global.document.getElementById('modal-root');
    if (!root) return;
    root.innerHTML = '<div class="modal-backdrop fixed inset-0 bg-black/70 flex items-center justify-center p-4" onclick="if(event.target===this)cm()">' +
      '<div class="theme-dialog w-full max-w-3xl" onclick="event.stopPropagation()">' +
      '<div class="theme-dialog-head"><div><h3>主题设置</h3><p>选择后立即生效，并在下次打开时自动恢复。</p></div><button type="button" onclick="cm()" class="theme-close" title="关闭" aria-label="关闭">×</button></div>' +
      '<div class="theme-grid">' + themes.map(optionHtml).join('') + '</div>' +
      '<div class="theme-dialog-foot"><p>主题只改变界面配色，不影响PDF原文、项目数据和提取结果。</p><button type="button" onclick="cm()" class="btn btn-sm">完成</button></div>' +
      '</div></div>';
    updateIndicators();
  }

  global.ThemeManager = {
    themes: themes,
    current: current,
    getTheme: getTheme,
    apply: apply,
    open: open
  };
  global.openThemeSettings = open;
  apply(savedThemeId(), false);
})(window);
