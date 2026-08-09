// AudiPick Electron 主进程
const { app, BrowserWindow, ipcMain, net } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { loadHubLlmSettings } = require('./hub_llm_bridge');

const DESKTOP_UA = 'AudiPick/1.4.6 (Electron; Windows)';

let win;

function writeBridgeDiagnostic(payload) {
  const target = process.env.AUDIPICK_DIAG_FILE;
  if (!target) return;
  try { fs.writeFileSync(target, JSON.stringify(payload), 'utf8'); }
  catch (e) { console.error('[AudiPick] bridge diagnostic write failed:', e && e.message); }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: '#1A1A1A',
    title: 'AudiPick - 智能合同审计助手 v1.4.6',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      // OCR/PDF parsing must keep running when the window is minimized.
      backgroundThrottling: false
    }
  });

  // 隐藏菜单栏
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'audipick.html'));
  win.focus();
}

app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling,MediaSessionService');
// 禁用缩放以避免界面被拉大
app.whenReady().then(() => {
  createWindow();
  win.webContents.setVisualZoomLevelLimits(1, 1);
  win.webContents.on('did-finish-load', () => {
    win.webContents.setZoomFactor(1);
    win.webContents.setVisualZoomLevelLimits(1, 1);
    win.webContents.executeJavaScript('window.desktop && window.desktop.ping ? window.desktop.ping() : Promise.resolve({ok:false})')
      .then((result) => {
        const diagnostic = { ready: !!(result && result.ok), version: result && result.version || '' };
        console.log('[AudiPick] desktop bridge ready:', diagnostic.ready, diagnostic.version);
        writeBridgeDiagnostic(diagnostic);
      })
      .catch((e) => {
        console.error('[AudiPick] desktop bridge check failed:', e && e.message);
        writeBridgeDiagnostic({ ready: false, error: String(e && e.message || e) });
      });
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ===== 主进程无 CORS 的通用 fetch（供百度OCR等第三方接口使用）=====
function isRetryableNetworkError(msg) {
  return /Failed to fetch|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|ENETUNREACH|EAI_AGAIN|socket hang up|network|fetch failed|请求超时/i.test(msg || '');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 优先走 Chromium 网络栈（自动使用系统代理），失败再退回 Node https
async function desktopFetchOnce(urlStr, options) {
  options = options || {};
  const headers = Object.assign({ 'User-Agent': DESKTOP_UA }, options.headers || {});
  const method = options.method || 'GET';
  const body = options.body || null;
  const timeoutMs = Math.max(1000, Math.min(Number(options.timeoutMs) || 90000, 300000));

  let chromiumError = '';
  if (typeof net.fetch === 'function') {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const init = { method, headers, signal: controller.signal };
      if (body != null) init.body = body;
      const resp = await net.fetch(urlStr, init);
      const bodyText = await resp.text();
      return {
        ok: resp.ok,
        status: resp.status,
        statusText: resp.statusText || '',
        bodyText
      };
    } catch (e) {
      if (controller.signal.aborted) {
        return { ok: false, status: 0, statusText: `请求超时(${Math.round(timeoutMs / 1000)}s)`, bodyText: '' };
      }
      chromiumError = String(e && e.message || e || 'Chromium fetch failed');
    } finally {
      clearTimeout(timeout);
    }
  }

  return new Promise((resolve) => {
    let u;
    try { u = new URL(urlStr); }
    catch (e) { resolve({ ok: false, status: 0, statusText: '无效URL', bodyText: String(e && e.message) }); return; }
    const lib = u.protocol === 'https:' ? https : http;
    let reqBody = body;
    if (reqBody && !Buffer.isBuffer(reqBody)) reqBody = Buffer.from(reqBody);
    if (reqBody && headers['Content-Length'] === undefined && headers['content-length'] === undefined) {
      headers['Content-Length'] = Buffer.byteLength(reqBody);
    }
    const reqOptions = {
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers,
      servername: u.hostname
    };
    const req = lib.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          statusText: res.statusMessage || '',
          bodyText: buf.toString('utf8')
        });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求超时(${Math.round(timeoutMs / 1000)}s)`)));
    req.on('error', (e) => resolve({
      ok: false,
      status: 0,
      statusText: [chromiumError, String(e && e.message || e)].filter(Boolean).join(' | '),
      bodyText: ''
    }));
    if (reqBody) req.write(reqBody);
    req.end();
  });
}

async function desktopFetch(urlStr, options) {
  const maxAttempts = 3;
  let last = { ok: false, status: 0, statusText: '未知网络错误', bodyText: '' };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await desktopFetchOnce(urlStr, options);
    if (last.ok || last.status > 0) return last;
    if (/请求超时/i.test(last.statusText)) return last;
    if (!isRetryableNetworkError(last.statusText) || attempt === maxAttempts) return last;
    await sleep(800 * attempt);
  }
  return last;
}

ipcMain.handle('desktop-fetch', async (_event, urlStr, options) => {
  try {
    return await desktopFetch(urlStr, options);
  }
  catch (e) { return { ok: false, status: 0, statusText: String(e && e.message), bodyText: '' }; }
});

ipcMain.handle('desktop-ping', () => ({ ok: true, version: '1.4.6-desktop' }));

ipcMain.handle('hub-llm-settings', () => {
  const appDataRoot = process.env.APPDATA || app.getPath('appData');
  return loadHubLlmSettings(appDataRoot);
});

ipcMain.handle('focus-window', () => {
  if (win && !win.isDestroyed()) {
    win.focus();
    win.webContents.focus();
  }
  return true;
});
