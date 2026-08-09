// AudiPick Electron 预加载脚本：把主进程能力安全暴露给网页
const { contextBridge, ipcRenderer } = require('electron');
let pdfjsPaths = null;
try {
  const path = require('path');
  const { pathToFileURL } = require('url');
  const pdfRoot = path.join(__dirname, 'vendor', 'pdfjs');
  pdfjsPaths = {
    workerSrc: pathToFileURL(path.join(pdfRoot, 'legacy', 'build', 'pdf.worker.min.js')).href,
    cMapUrl: pathToFileURL(path.join(pdfRoot, 'cmaps')).href + '/',
    standardFontDataUrl: pathToFileURL(path.join(pdfRoot, 'standard_fonts')).href + '/'
  };
} catch (e) {
  console.error('[AudiPick] PDF.js local path initialization failed:', e && e.message);
}

contextBridge.exposeInMainWorld('desktop', {
  // 无CORS的fetch，供百度OCR等第三方接口绕过浏览器跨域限制
  fetch: (url, options) => ipcRenderer.invoke('desktop-fetch', url, options),
  ping: () => ipcRenderer.invoke('desktop-ping'),
  // 测试连接/IPC 后恢复窗口焦点，避免弹窗无法输入
  focusWindow: () => ipcRenderer.invoke('focus-window'),
  // PDF.js 本地 CMap/字体（file:// 下必须用绝对 URL）
  pdfjs: pdfjsPaths,
  // 标识当前运行在桌面版
  isDesktop: true,
  bridgeVersion: '1.4.6-desktop'
});
