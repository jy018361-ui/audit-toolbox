(function (global) {
  'use strict';

  var STORAGE_KEY = 'ap_theme';
  var DEFAULT_THEME = 'classic-dark';
  var themes = [
    {
      id: 'classic-dark', name: '经典黄黑', shortName: '黄黑',
      description: '暖炭黑底配低饱和黄铜',
      swatches: ['#141617', '#1D1F20', '#C4933B'],
      palette: { appBg: '#121415', surface: '#1D1F20', text: '#EDF0ED', muted: '#AEB5AF', accent: '#C4933B', accentText: '#171816', accentInk: '#D3A853', sidebar: '#141617', sidebarText: '#EDF0ED', sidebarMuted: '#B8BEB8', sidebarAccent: '#D8B66B' }
    },
    {
      id: 'yellow-light', name: '明亮黄白', shortName: '黄白',
      description: '暖纸白底配克制琥珀',
      swatches: ['#433923', '#FFFCF5', '#8F6819'],
      palette: { appBg: '#F3EEE3', surface: '#FFFCF5', text: '#29261F', muted: '#6B6559', accent: '#8F6819', accentText: '#FFFFFF', accentInk: '#68490F', sidebar: '#433923', sidebarText: '#FFF8E9', sidebarMuted: '#E3D6BC', sidebarAccent: '#D8B05A' }
    },
    {
      id: 'blue-white', name: '专业蓝白', shortName: '蓝白',
      description: '雾蓝灰层级配沉稳海军蓝',
      swatches: ['#20384C', '#FBFDFE', '#315D83'],
      palette: { appBg: '#EDF2F5', surface: '#FBFDFE', text: '#24313B', muted: '#5D6C77', accent: '#315D83', accentText: '#FFFFFF', accentInk: '#244B6C', sidebar: '#20384C', sidebarText: '#F1F7FA', sidebarMuted: '#C8D8E2', sidebarAccent: '#83A9C5' }
    },
    {
      id: 'red-white', name: '利落红白', shortName: '红白',
      description: '暖灰白底配克制陶红',
      swatches: ['#49302F', '#FFFDFB', '#9B4B45'],
      palette: { appBg: '#F3EFED', surface: '#FFFDFB', text: '#302725', muted: '#716361', accent: '#9B4B45', accentText: '#FFFFFF', accentInk: '#843E39', sidebar: '#49302F', sidebarText: '#FFF6F3', sidebarMuted: '#E7CCC7', sidebarAccent: '#D39A91' }
    },
    {
      id: 'yellow-blue', name: '醒目黄蓝', shortName: '黄蓝',
      description: '冷雾蓝底配海军蓝与黄铜',
      swatches: ['#1C3348', '#FCFDFC', '#A97925'],
      palette: { appBg: '#EBF0F1', surface: '#FCFDFC', text: '#243441', muted: '#5A6B76', accent: '#A97925', accentText: '#171816', accentInk: '#8E641D', sidebar: '#1C3348', sidebarText: '#F6FAFB', sidebarMuted: '#CFDEE4', sidebarAccent: '#CAA358' }
    },
    {
      id: 'yellow-green', name: '清新黄绿', shortName: '黄绿',
      description: '鼠尾草浅底配森林绿',
      swatches: ['#30483B', '#FBFDF8', '#68782D'],
      palette: { appBg: '#EDF1E7', surface: '#FBFDF8', text: '#28352D', muted: '#607066', accent: '#68782D', accentText: '#FFFFFF', accentInk: '#5E6D27', sidebar: '#30483B', sidebarText: '#F5FAF4', sidebarMuted: '#D2E0D5', sidebarAccent: '#B1BF78' }
    },
    {
      id: 'red-yellow-ivory', name: '红黄米白', shortName: '红黄米白',
      description: '宣纸米白配朱砂与哑金',
      swatches: ['#67352F', '#FFFAF0', '#A04A3F'],
      palette: { appBg: '#F3EADB', surface: '#FFFAF0', text: '#352721', muted: '#74645B', accent: '#A04A3F', accentText: '#FFFFFF', accentInk: '#893E35', sidebar: '#67352F', sidebarText: '#FFF5E9', sidebarMuted: '#EFD4C6', sidebarAccent: '#D7B46D' }
    },
    {
      id: 'teal-dark', name: '深色青绿', shortName: '深色青绿',
      description: '深海青底配柔和青玉',
      swatches: ['#0E2525', '#162B2B', '#5AA99B'],
      palette: { appBg: '#0C1C1D', surface: '#162B2B', text: '#EAF3F0', muted: '#AABDB8', accent: '#5AA99B', accentText: '#102321', accentInk: '#85CABD', sidebar: '#0E2525', sidebarText: '#EDF6F3', sidebarMuted: '#B9CFCA', sidebarAccent: '#78B7AA' }
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
