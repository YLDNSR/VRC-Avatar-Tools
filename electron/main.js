// Main process: windows, local file access, settings, Syphon output, global input.
const {
  app, BrowserWindow, ipcMain, dialog, protocol, net, shell, screen,
  systemPreferences, session, Menu, globalShortcut,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const store = require('./store');
const { readAvatarMeta } = require('./avatar-meta');
const profiles = require('./profiles');

const isDev = !app.isPackaged;
const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';
if (process.env.VAV_USER_DATA) app.setPath('userData', process.env.VAV_USER_DATA);
const distDir = path.join(__dirname, '..', 'dist');

let native = null;
function loadNative() {
  const candidates = [
    path.join(__dirname, '..', 'native', 'build', 'Release', 'vav_native.node'),
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'native', 'build', 'Release', 'vav_native.node'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) { native = require(p); return; }
    } catch (err) {
      console.error('native addon load failed', p, err);
    }
  }
  console.warn('native addon not found; global keys are disabled');
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  { scheme: 'vavfile', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, bypassCSP: true } },
]);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.task': 'application/octet-stream', '.bin': 'application/octet-stream',
  '.gltf': 'model/gltf+json', '.glb': 'model/gltf-binary', '.vrm': 'model/gltf-binary', '.vrma': 'model/gltf-binary',
  '.ktx2': 'image/ktx2', '.webp': 'image/webp', '.anim': 'text/plain', '.toml': 'text/plain', '.fbx': 'application/octet-stream',
};

async function serveFile(filePath) {
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) return new Response('not found', { status: 404 });
    const res = await net.fetch(pathToFileURL(filePath).toString());
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    return new Response(res.body, {
      status: 200,
      headers: { 'content-type': type, 'content-length': String(stat.size), 'access-control-allow-origin': '*' },
    });
  } catch {
    return new Response('not found', { status: 404 });
  }
}

function registerProtocols() {
  protocol.handle('app', (req) => {
    const url = new URL(req.url);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/viewer.html';
    const filePath = path.normalize(path.join(distDir, rel));
    if (!filePath.startsWith(distDir)) return new Response('forbidden', { status: 403 });
    return serveFile(filePath);
  });
  protocol.handle('vavfile', (req) => {
    const url = new URL(req.url);
    let filePath = decodeURIComponent(url.pathname);
    // Windows: vavfile://local/C:/Users/… → C:/Users/…
    if (isWin && /^\/[A-Za-z]:/.test(filePath)) filePath = filePath.slice(1);
    return serveFile(filePath);
  });
}

// ---------------------------------------------------------------------------
// Windows

let viewerWin = null;
let captureWin = null;
const viewerState = { transparent: false, alwaysOnTop: true, clickThrough: true, ignoring: false, wantCursor: false };

function appUrl(page) {
  return `app://bundle/${page}`;
}

function createViewer() {
  const bounds = store.get('window.viewer') || {};
  viewerWin = new BrowserWindow({
    width: bounds.width || 900,
    height: bounds.height || 1000,
    x: bounds.x,
    y: bounds.y,
    minWidth: 240,
    minHeight: 240,
    title: 'VRC Avatar Tools',
    transparent: true,
    backgroundColor: '#00000000',
    // macOS keeps the traffic lights over the page; Windows gets a frameless window with the
    // page's own minimize / close buttons (transparent windows cannot have a native frame there).
    ...(isMac ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: 14 } } : { frame: false }),
    hasShadow: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-viewer.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  viewerWin.loadURL(appUrl('viewer.html'));
  viewerWin.once('ready-to-show', () => viewerWin.show());
  const saveBounds = () => {
    if (!viewerWin || viewerWin.isDestroyed() || viewerWin.isMinimized()) return;
    store.set('window.viewer', viewerWin.getBounds());
  };
  viewerWin.on('moved', saveBounds);
  viewerWin.on('resized', saveBounds);
  viewerWin.on('minimize', () => sendViewer('win:minimized', true));
  viewerWin.on('restore', () => sendViewer('win:minimized', false));
  viewerWin.on('focus', () => sendViewer('win:focus', true));
  viewerWin.on('blur', () => sendViewer('win:focus', false));
  viewerWin.on('closed', () => {
    viewerWin = null;
    stopSyphon();
    unwatchAvatar();
  });
}

function createCapture() {
  if (captureWin && !captureWin.isDestroyed()) {
    captureWin.show();
    captureWin.focus();
    return;
  }
  const bounds = store.get('window.capture') || {};
  captureWin = new BrowserWindow({
    width: bounds.width || 1180,
    height: bounds.height || 860,
    x: bounds.x,
    y: bounds.y,
    minWidth: 760,
    minHeight: 560,
    title: 'VRC Avatar Tools Capture',
    ...(isMac ? { titleBarStyle: 'hiddenInset' } : { autoHideMenuBar: true }),
    backgroundColor: '#15161a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-capture.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  captureWin.loadURL(appUrl('capture.html'));
  captureWin.once('ready-to-show', () => captureWin.show());
  const saveBounds = () => {
    if (!captureWin || captureWin.isDestroyed()) return;
    store.set('window.capture', captureWin.getBounds());
  };
  captureWin.on('moved', saveBounds);
  captureWin.on('resized', saveBounds);
  captureWin.on('closed', () => { captureWin = null; });
}

function sendViewer(channel, ...args) {
  if (viewerWin && !viewerWin.isDestroyed()) viewerWin.webContents.send(channel, ...args);
}

// ---------------------------------------------------------------------------
// Transparent mode, click-through and cursor tracking

function applyTransparentMode() {
  if (!viewerWin) return;
  const t = viewerState.transparent;
  if (isMac) {
    viewerWin.setWindowButtonVisibility(!t);
    viewerWin.setVisibleOnAllWorkspaces(t && viewerState.alwaysOnTop, { visibleOnFullScreen: true });
  }
  viewerWin.setHasShadow(!t);
  viewerWin.setAlwaysOnTop(t && viewerState.alwaysOnTop, 'floating');
  if (!t || !viewerState.clickThrough) setIgnore(false);
}

function setIgnore(ignore) {
  if (!viewerWin || viewerState.ignoring === ignore) return;
  viewerState.ignoring = ignore;
  viewerWin.setIgnoreMouseEvents(ignore, { forward: true });
}

let cursorTimer = null;
function updateCursorPolling() {
  const need = !!viewerWin && (viewerState.wantCursor || (viewerState.transparent && viewerState.clickThrough));
  if (need && !cursorTimer) {
    cursorTimer = setInterval(pollCursor, 33);
  } else if (!need && cursorTimer) {
    clearInterval(cursorTimer);
    cursorTimer = null;
  }
}

function pollCursor() {
  if (!viewerWin || viewerWin.isDestroyed()) return;
  const p = screen.getCursorScreenPoint();
  const b = viewerWin.getContentBounds();
  const mods = native ? native.getModifierFlags() : {};
  const buttons = native ? native.getMouseButtons() : 0;
  const display = screen.getDisplayNearestPoint(p);
  viewerWin.webContents.send('cursor', {
    x: p.x - b.x,
    y: p.y - b.y,
    width: b.width,
    height: b.height,
    screen: display.bounds,
    screenX: p.x,
    screenY: p.y,
    modifiers: mods,
    buttons,
  });
}

// ---------------------------------------------------------------------------
// Syphon output
//
// Syphon runs in a small helper process: IOSurfaces created inside an Electron
// process cannot be opened by Syphon clients (OBS). The viewer page writes BGRA
// frames into a shared memory file that the helper publishes.

const SHM_TOTAL = 4096 + 2 * 3840 * 2160 * 4;
let syphon = { proc: null, shmPath: null };

function helperPath() {
  const name = 'VRC Avatar Tools Syphon';
  const candidates = [
    path.join(__dirname, '..', 'native', 'build', 'helper', name),
    path.join(process.resourcesPath || '', 'helper', name),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function startSyphon(name) {
  stopSyphon();
  // Syphon is macOS only (Windows would need Spout); capture the window in OBS instead.
  if (!isMac) return { ok: false, reason: 'unsupported' };
  const exe = helperPath();
  if (!exe) return { ok: false, reason: 'helper' };
  const shmPath = path.join(os.tmpdir(), `vav-syphon-${process.pid}-${Date.now()}.shm`);
  const fd = fs.openSync(shmPath, 'w+');
  fs.ftruncateSync(fd, SHM_TOTAL);
  fs.closeSync(fd);
  const proc = spawn(exe, [name || 'VRC Avatar Tools', shmPath], { stdio: ['ignore', 'ignore', 'pipe'] });
  proc.stderr.on('data', (d) => console.error('[syphon-helper]', String(d).trim()));
  proc.on('exit', (code) => {
    if (syphon.proc === proc) {
      syphon.proc = null;
      sendViewer('syphon:exited', code);
    }
  });
  syphon = { proc, shmPath };
  return { ok: true, shmPath };
}

function stopSyphon() {
  if (syphon.proc) syphon.proc.kill('SIGTERM');
  if (syphon.shmPath) {
    try { fs.unlinkSync(syphon.shmPath); } catch { /* already gone */ }
  }
  syphon = { proc: null, shmPath: null };
}

// ---------------------------------------------------------------------------
// Global gesture keys (Shift + F1..F8)

const FKEY_CODES = { 122: 0, 120: 1, 99: 2, 118: 3, 96: 4, 97: 5, 98: 6, 100: 7 };
let globalKeysOn = false;
let shortcutKeysOn = false;

/** Without the macOS key monitor (Windows): Shift+F1..F8 as global shortcuts (left hand). */
function setShortcutKeys(enable) {
  for (let i = 1; i <= 8; i++) globalShortcut.unregister(`Shift+F${i}`);
  shortcutKeysOn = false;
  if (!enable) return { ok: true };
  let ok = true;
  for (let i = 1; i <= 8; i++) {
    ok = globalShortcut.register(`Shift+F${i}`, () => sendViewer('gesture-key', { side: 'left', index: i - 1 })) && ok;
  }
  shortcutKeysOn = ok;
  return { ok, reason: ok ? undefined : 'shortcut' };
}

function setGlobalKeys(enable) {
  if (!isMac) return setShortcutKeys(enable);
  if (!native) return { ok: false, reason: 'native' };
  if (!enable) {
    if (globalKeysOn) native.keyMonitorStop();
    globalKeysOn = false;
    return { ok: true };
  }
  if (!native.inputMonitoringAccess(true)) return { ok: false, reason: 'permission' };
  const ok = native.keyMonitorStart((ev) => {
    if (ev.type !== 'down') return;
    const idx = FKEY_CODES[ev.keyCode];
    if (idx == null || !ev.modifiers.shift) return;
    if (viewerWin && viewerWin.isFocused()) return; // the page handles it itself
    const side = ev.modifiers.rightShift && !ev.modifiers.leftShift ? 'right' : 'left';
    sendViewer('gesture-key', { side, index: idx });
  });
  globalKeysOn = !!ok;
  return { ok: !!ok, reason: ok ? undefined : 'tap' };
}

// ---------------------------------------------------------------------------
// Avatar file watching (auto reload when re-exported)

let watchedPath = null;
let watchTimer = null;
function watchAvatar(filePath) {
  unwatchAvatar();
  if (!filePath) return;
  watchedPath = filePath;
  let last = null;
  try { const s = fs.statSync(filePath); last = `${s.size}:${s.mtimeMs}`; } catch { /* ignore */ }
  fs.watchFile(filePath, { interval: 1000 }, (cur) => {
    const sig = `${cur.size}:${cur.mtimeMs}`;
    if (cur.size === 0 || sig === last) return;
    last = sig;
    clearTimeout(watchTimer);
    // Wait until the exporter finishes writing.
    watchTimer = setTimeout(() => sendViewer('avatar:changed', filePath), 1200);
  });
}
function unwatchAvatar() {
  if (watchedPath) fs.unwatchFile(watchedPath);
  watchedPath = null;
  clearTimeout(watchTimer);
}

// ---------------------------------------------------------------------------
// IPC

const AVATAR_EXT = ['.vrm', '.glb', '.gltf'];
const ANIM_EXT = ['.vrma', '.anim', '.glb', '.gltf'];

function registerIpc() {
  ipcMain.on('store:get-all', (e) => { e.returnValue = store.all(); });
  ipcMain.on('store:set', (_e, key, value) => store.set(key, value));

  ipcMain.handle('dialog:open-avatar', async () => {
    const r = await dialog.showOpenDialog(viewerWin, {
      properties: ['openFile'],
      filters: [{ name: 'Avatar', extensions: AVATAR_EXT.map((e) => e.slice(1)) }],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('dialog:open-folder', async (_e, defaultPath) => {
    const r = await dialog.showOpenDialog(viewerWin, { properties: ['openDirectory'], defaultPath });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('dialog:open-animations', async (_e, multi) => {
    const r = await dialog.showOpenDialog(viewerWin, {
      properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: [{ name: 'Animation', extensions: ANIM_EXT.map((e) => e.slice(1)) }],
    });
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle('fs:read-text', async (_e, p) => fs.promises.readFile(p, 'utf8'));
  ipcMain.handle('fs:exists', async (_e, p) => fs.existsSync(p));
  ipcMain.handle('fs:stat', async (_e, p) => {
    try { const s = await fs.promises.stat(p); return { size: s.size, mtime: s.mtimeMs }; } catch { return null; }
  });

  ipcMain.handle('avatars:list-folder', async (_e, dir) => {
    const out = [];
    const walk = async (d, depth) => {
      let entries = [];
      try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; }
      for (const ent of entries) {
        if (ent.name.startsWith('.')) continue;
        const full = path.join(d, ent.name);
        if (ent.isDirectory() && depth < 2) await walk(full, depth + 1);
        else if (ent.isFile() && AVATAR_EXT.includes(path.extname(ent.name).toLowerCase())) {
          const meta = await readAvatarMeta(full).catch(() => ({}));
          let stat = null;
          try { stat = await fs.promises.stat(full); } catch { /* ignore */ }
          out.push({
            path: full,
            file: ent.name,
            title: meta.title || path.basename(ent.name, path.extname(ent.name)),
            author: meta.author || '',
            version: meta.version || '',
            thumbnail: meta.thumbnail || null,
            size: stat ? stat.size : 0,
            mtime: stat ? stat.mtimeMs : 0,
          });
        }
      }
    };
    await walk(dir, 0);
    out.sort((a, b) => a.title.localeCompare(b.title));
    return out;
  });

  ipcMain.on('avatar:watch', (_e, p) => watchAvatar(p));

  ipcMain.handle('profiles:list', async () => profiles.list());
  ipcMain.handle('profiles:open-folder', async () => shell.openPath(profiles.dir()));

  ipcMain.handle('sys:info', async () => ({
    os: `${isMac ? 'macOS' : isWin ? 'Windows' : process.platform} ${process.getSystemVersion()}`,
    arch: process.arch,
    cpu: os.cpus()[0] ? os.cpus()[0].model : 'unknown',
    cores: os.cpus().length,
    memory: os.totalmem(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    appVersion: app.getVersion(),
  }));

  ipcMain.on('win:set-transparent', (_e, opts) => {
    Object.assign(viewerState, opts);
    applyTransparentMode();
    updateCursorPolling();
  });
  ipcMain.on('win:set-ignore-mouse', (_e, ignore) => {
    if (!viewerState.transparent || !viewerState.clickThrough) ignore = false;
    setIgnore(!!ignore);
  });
  ipcMain.on('win:want-cursor', (_e, want) => {
    viewerState.wantCursor = !!want;
    updateCursorPolling();
  });
  ipcMain.on('win:move-by', (_e, dx, dy) => {
    if (!viewerWin) return;
    const [x, y] = viewerWin.getPosition();
    viewerWin.setPosition(Math.round(x + dx), Math.round(y + dy));
  });
  // Windows cannot resize a transparent window by its edges; the settings menu sets the size instead.
  ipcMain.on('win:set-size', (_e, width, height) => {
    if (!viewerWin) return;
    viewerWin.setSize(Math.round(width), Math.round(height));
    store.set('window.viewer', viewerWin.getBounds());
  });
  ipcMain.handle('win:get-size', () => (viewerWin ? viewerWin.getSize() : [0, 0]));
  ipcMain.on('win:close', () => viewerWin && viewerWin.close());
  ipcMain.on('win:minimize', () => viewerWin && viewerWin.minimize());

  ipcMain.handle('syphon:start', (_e, name) => startSyphon(name));
  ipcMain.handle('syphon:stop', () => { stopSyphon(); return true; });

  ipcMain.handle('keys:set-global', (_e, enable) => setGlobalKeys(enable));
  ipcMain.handle('capture:open', () => { createCapture(); return true; });
  ipcMain.handle('viewer:open', () => {
    if (!viewerWin) createViewer(); else viewerWin.focus();
    return true;
  });
  ipcMain.handle('media:request', async (_e, kind) => {
    // Only macOS asks per app; Windows grants camera / microphone through its own privacy settings.
    if (!isMac) return true;
    try {
      const status = systemPreferences.getMediaAccessStatus(kind);
      if (status === 'granted') return true;
      return await systemPreferences.askForMediaAccess(kind);
    } catch { return false; }
  });
  ipcMain.handle('shell:open-external', (_e, url) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
  });
  ipcMain.on('app:set-language', (_e, lang) => buildMenu(lang));
  // Quit from the right-click menu (a transparent window has no close button).
  ipcMain.on('app:quit', () => app.quit());

  // Open at login (macOS login item). Only the packaged app registers itself; a development
  // run would register the bare Electron binary.
  ipcMain.handle('login:get', () => loginItemState());
  ipcMain.handle('login:set', (_e, enable) => {
    if (!app.isPackaged) return loginItemState();
    try {
      app.setLoginItemSettings({ openAtLogin: !!enable });
    } catch (err) {
      return { ...loginItemState(), error: String((err && err.message) || err) };
    }
    return loginItemState();
  });
  ipcMain.handle('login:open-settings', () => shell.openExternal(isMac
    ? 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension'
    : 'ms-settings:startupapps'));
}

/** { supported, openAtLogin, status: 'enabled' | 'not-registered' | 'requires-approval' | 'not-found' | 'unsupported' } */
function loginItemState() {
  if (!app.isPackaged) return { supported: false, openAtLogin: false, status: 'unsupported' };
  const s = app.getLoginItemSettings();
  const status = s.status || (s.openAtLogin ? 'enabled' : 'not-registered');
  return { supported: true, openAtLogin: status === 'enabled' || status === 'requires-approval' || !!s.openAtLogin, status, appPath: app.getAppPath() };
}

// ---------------------------------------------------------------------------
// Menu

const MENU_TEXT = {
  ko: { capture: '캡처 앱 열기', viewer: '뷰어 열기', window: '윈도우', file: '파일', openAvatar: '아바타 파일 열기…', view: '보기', help: '도움말', guide: '맥 사용 가이드' },
  ja: { capture: 'キャプチャーアプリを開く', viewer: 'ビューアーを開く', window: 'ウインドウ', file: 'ファイル', openAvatar: 'アバターファイルを開く…', view: '表示', help: 'ヘルプ', guide: 'Mac 版ガイド' },
  en: { capture: 'Open Capture App', viewer: 'Open Viewer', window: 'Window', file: 'File', openAvatar: 'Open Avatar File…', view: 'View', help: 'Help', guide: 'Mac Guide' },
  'zh-CN': { capture: '打开捕捉应用', viewer: '打开查看器', window: '窗口', file: '文件', openAvatar: '打开头像文件…', view: '显示', help: '帮助', guide: 'Mac 版指南' },
  th: { capture: 'เปิดแอปจับการเคลื่อนไหว', viewer: 'เปิดตัวแสดงผล', window: 'หน้าต่าง', file: 'ไฟล์', openAvatar: 'เปิดไฟล์อวาตาร์…', view: 'มุมมอง', help: 'ช่วยเหลือ', guide: 'คู่มือ Mac' },
};

function resolveLang(lang) {
  if (lang && lang !== 'auto' && MENU_TEXT[lang]) return lang;
  const loc = app.getLocale();
  if (loc.startsWith('ko')) return 'ko';
  if (loc.startsWith('ja')) return 'ja';
  if (loc.startsWith('zh')) return 'zh-CN';
  if (loc.startsWith('th')) return 'th';
  return 'en';
}

function guidePath() {
  const packaged = path.join(process.resourcesPath || '', 'docs', 'GUIDE.ko.md');
  return fs.existsSync(packaged) ? packaged : path.join(__dirname, '..', 'docs', 'GUIDE.ko.md');
}

function buildMenu(lang) {
  const t = MENU_TEXT[resolveLang(lang || store.get('settings.language'))];
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: t.file,
      submenu: [
        { label: t.openAvatar, accelerator: 'CmdOrCtrl+O', click: () => sendViewer('menu:open-avatar') },
        { type: 'separator' },
        { label: t.viewer, accelerator: 'CmdOrCtrl+Shift+V', click: () => (viewerWin ? viewerWin.focus() : createViewer()) },
        { label: t.capture, accelerator: 'CmdOrCtrl+Shift+C', click: () => createCapture() },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: t.view,
      submenu: [
        { role: 'reload', visible: isDev },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { label: t.window, role: 'windowMenu' },
    {
      label: t.help,
      submenu: [{ label: t.guide, click: () => shell.openPath(guidePath()) }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  loadNative();
  registerProtocols();
  profiles.ensure(path.join(__dirname, '..', 'resources', 'avatar_profiles'));
  registerIpc();
  buildMenu();

  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    const url = wc.getURL();
    cb(url.startsWith('app://') && ['media', 'clipboard-sanitized-write', 'fullscreen'].includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => {
    return (origin || '').startsWith('app://') && ['media', 'clipboard-sanitized-write'].includes(permission);
  });

  createViewer();
  if (process.argv.includes('--capture')) createCapture();
  // Windows "Open with" / double-clicked .vrm: the file arrives as a command-line argument.
  const fileArg = avatarArg(process.argv);
  if (fileArg) viewerWin.webContents.once('did-finish-load', () => setTimeout(() => sendViewer('menu:open-path', fileArg), 1500));
  if (process.env.VAV_TEST_SCRIPT) runTestScript(process.env.VAV_TEST_SCRIPT);

  app.on('activate', () => {
    if (!viewerWin) createViewer();
  });
});

// Development-only automation: VAV_TEST_SCRIPT=steps.json runs
// [{ "wait": ms }, { "eval": "js", "target": "viewer|capture" }, { "shot": "out.png" }, { "quit": true }]
async function runTestScript(file) {
  const steps = JSON.parse(fs.readFileSync(file, 'utf8'));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(1500);
  for (const step of steps) {
    try {
      const win = step.target === 'capture' ? captureWin : viewerWin;
      if (step.wait) await sleep(step.wait);
      if (step.openCapture) createCapture();
      if (step.eval && win) {
        const r = await win.webContents.executeJavaScript(step.eval, true);
        if (step.log !== false) console.log('[test] eval ->', JSON.stringify(r));
      }
      if (step.shot && win) {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(step.shot, img.toPNG());
        console.log('[test] shot', step.shot);
      }
      if (step.exec) {
        const out = await new Promise((resolve) => {
          const pr = spawn(step.exec[0], step.exec.slice(1));
          let buf = '';
          pr.stdout.on('data', (d) => { buf += d; });
          pr.on('exit', () => resolve(buf));
        });
        console.log('[test] exec ->', out.trim().replace(/\n/g, ' | '));
      }
      if (step.quit) app.quit();
    } catch (err) {
      console.log('[test] step failed', JSON.stringify(step).slice(0, 120), err && err.message);
    }
  }
}

function avatarArg(argv) {
  if (isMac) return null;
  return argv.slice(1).find((a) => /\.(vrm|glb|gltf)$/i.test(a) && fs.existsSync(a)) || null;
}

// Windows: a second launch (opening another .vrm) goes to the running viewer.
if (isWin && !process.env.VAV_TEST_SCRIPT) {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    app.on('second-instance', (_e, argv) => {
      if (!viewerWin) return;
      if (viewerWin.isMinimized()) viewerWin.restore();
      viewerWin.focus();
      const file = avatarArg(argv);
      if (file) sendViewer('menu:open-path', file);
    });
  }
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  stopSyphon();
  if (native && globalKeysOn) native.keyMonitorStop();
  if (shortcutKeysOn) globalShortcut.unregisterAll();
  store.flush();
});

// Open files dropped on the dock icon / Finder "Open With".
app.on('open-file', (e, filePath) => {
  e.preventDefault();
  if (viewerWin) sendViewer('menu:open-path', filePath);
  else app.once('browser-window-created', () => setTimeout(() => sendViewer('menu:open-path', filePath), 1500));
});
