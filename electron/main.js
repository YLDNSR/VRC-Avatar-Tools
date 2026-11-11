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
// Beta builds ("VRC Avatar Tools Beta", npm run dist:beta) keep their own settings folder, so trying
// new features never touches the stable app's settings. The first beta launch starts from a copy of them.
const channel = process.env.VAV_CHANNEL || require('../package.json').vavChannel || 'stable';
const isBeta = channel === 'beta';
if (process.env.VAV_USER_DATA) app.setPath('userData', process.env.VAV_USER_DATA);
else if (isBeta) app.setPath('userData', path.join(app.getPath('appData'), 'VRC Avatar Tools Beta'));
if (isBeta && !process.env.VAV_USER_DATA) {
  const dst = path.join(app.getPath('userData'), 'settings.json');
  const src = path.join(app.getPath('appData'), 'VRC Avatar Tools', 'settings.json');
  try {
    if (!fs.existsSync(dst) && fs.existsSync(src)) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
  } catch (err) {
    console.error('beta settings copy failed', err);
  }
}
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
let studioBounds = null;
let mateBounds = null;
const viewerState = {
  transparent: false,
  mateMode: false,
  mateExpanded: false,
  alwaysOnTop: true,
  clickThrough: true,
  ignoring: false,
  wantCursor: false,
};

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
    title: isBeta ? 'VRC Avatar Tools Beta' : 'VRC Avatar Tools',
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
      additionalArguments: [`--vav-channel=${channel}`],
    },
  });
  viewerWin.loadURL(appUrl('viewer.html'));
  viewerWin.once('ready-to-show', () => {
    if (viewerWin && !viewerWin.isDestroyed()) {
      if (!viewerState.mateMode) studioBounds = viewerWin.getBounds();
      viewerWin.show();
    }
  });
  const saveBounds = () => {
    if (!viewerWin || viewerWin.isDestroyed() || viewerWin.isMinimized()) return;
    if (viewerState.mateMode) {
      if (!viewerState.mateExpanded) {
        mateBounds = viewerWin.getBounds();
        store.set('window.mate', mateBounds);
      }
      return;
    }
    studioBounds = viewerWin.getBounds();
    store.set('window.viewer', studioBounds);
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
// Transparent mode, Desktop Mate mode, click-through and cursor tracking

function workAreaForBounds(b) {
  const pt = { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
  const display = screen.getDisplayNearestPoint(pt);
  return { ...display.workArea };
}

function clampToWorkArea(b, wa) {
  const width = Math.min(Math.max(180, Math.round(b.width)), wa.width);
  const height = Math.min(Math.max(220, Math.round(b.height)), wa.height);
  const x = Math.min(Math.max(Math.round(b.x), wa.x), wa.x + Math.max(0, wa.width - width));
  const y = Math.min(Math.max(Math.round(b.y), wa.y), wa.y + Math.max(0, wa.height - height));
  return { x, y, width, height };
}

/**
 * Clamps a Desktop Mate pet window so the character's center stays on-screen while allowing
 * transparent margins of the pet frame to extend beyond the display/dock edges.
 */
function clampPetBounds(b, wa) {
  const width = Math.min(Math.max(180, Math.round(b.width)), Math.round(wa.width * 1.25));
  const height = Math.min(Math.max(220, Math.round(b.height)), Math.round(wa.height * 1.35));
  const cx = Math.min(Math.max(b.x + width * 0.5, wa.x + 60), wa.x + wa.width - 60);
  const cy = Math.min(Math.max(b.y + height * 0.5, wa.y + 60), wa.y + wa.height - 40);
  return {
    x: Math.round(cx - width * 0.5),
    y: Math.round(cy - height * 0.5),
    width,
    height,
  };
}

function resolveMateBounds(refBounds) {
  const wa = workAreaForBounds(refBounds);
  const saved = mateBounds || store.get('window.mate');
  const h = Math.min(Math.max(240, Math.round(saved?.height || 560)), Math.round(wa.height * 1.35));
  const w = Math.min(Math.max(180, Math.round(saved?.width || Math.round(h * 0.65))), Math.round(wa.width * 1.25));
  const x = saved?.x != null ? saved.x : wa.x + wa.width - w - 36;
  const y = saved?.y != null ? saved.y : wa.y + wa.height - h - 24;
  return clampPetBounds({ x, y, width: w, height: h }, wa);
}

function syncNativeWindowTraits() {
  if (!isMac || !viewerWin || viewerWin.isDestroyed()) return;
  if (native && typeof native.setWindowMateMode === 'function') {
    native.setWindowMateMode(viewerWin.getNativeWindowHandle(), !!(viewerState.mateMode || viewerState.transparent));
  }
}

function applyTransparentMode() {
  if (!viewerWin || viewerWin.isDestroyed()) return null;
  if (viewerState.mateMode) return applyMateMode(true);
  const t = viewerState.transparent;
  viewerWin.setResizable(!t);
  if (isMac) {
    viewerWin.setWindowButtonVisibility(!t);
    viewerWin.setVisibleOnAllWorkspaces(t && viewerState.alwaysOnTop, { visibleOnFullScreen: true });
    syncNativeWindowTraits();
  }
  viewerWin.setHasShadow(!t);
  viewerWin.setAlwaysOnTop(t && viewerState.alwaysOnTop, 'floating');
  if (!t) setIgnore(false);
  return { overlay: false, from: viewerWin.getBounds(), to: viewerWin.getBounds() };
}

function applyMateMode(on) {
  if (!viewerWin || viewerWin.isDestroyed()) return null;
  const wasMate = viewerState.mateMode;
  viewerState.mateMode = !!on;
  if (viewerState.mateMode) {
    viewerState.transparent = true;
    const from = viewerWin.getBounds();
    if (!wasMate) {
      studioBounds = from;
      store.set('window.viewer', studioBounds);
      const target = resolveMateBounds(from);
      mateBounds = target;
      viewerState.mateExpanded = false;
      viewerWin.setMinimumSize(160, 220);
      viewerWin.setBounds(target, false);
    }
    viewerWin.setResizable(false);
    viewerWin.setHasShadow(false);
    if (isMac) {
      viewerWin.setWindowButtonVisibility(false);
      viewerWin.setVisibleOnAllWorkspaces(viewerState.alwaysOnTop, { visibleOnFullScreen: true });
      syncNativeWindowTraits();
    }
    viewerWin.setAlwaysOnTop(viewerState.alwaysOnTop, 'screen-saver');
    const to = viewerWin.getBounds();
    const wa = workAreaForBounds(to);
    return { mateMode: true, from, to, workArea: wa };
  } else {
    const from = viewerWin.getBounds();
    if (wasMate && !viewerState.mateExpanded) {
      mateBounds = from;
      store.set('window.mate', mateBounds);
    }
    viewerState.mateExpanded = false;
    viewerState.transparent = false;
    const base = studioBounds || store.get('window.viewer') || { width: 900, height: 1000 };
    const wa = workAreaForBounds(from);
    const to = clampToWorkArea({
      x: base.x ?? Math.round(wa.x + (wa.width - (base.width || 900)) / 2),
      y: base.y ?? Math.round(wa.y + (wa.height - (base.height || 1000)) / 2),
      width: Math.max(420, base.width || 900),
      height: Math.max(420, base.height || 1000),
    }, wa);
    if (isMac) {
      syncNativeWindowTraits();
      viewerWin.setWindowButtonVisibility(true);
      viewerWin.setVisibleOnAllWorkspaces(false);
    }
    viewerWin.setAlwaysOnTop(false);
    viewerWin.setHasShadow(true);
    viewerWin.setResizable(true);
    viewerWin.setMinimumSize(240, 240);
    viewerWin.setBounds(to, false);
    studioBounds = viewerWin.getBounds();
    store.set('window.viewer', studioBounds);
    setIgnore(false);
    return { mateMode: false, from, to: studioBounds, workArea: wa };
  }
}

function resizeMateWindow(opts = {}) {
  if (!viewerWin || viewerWin.isDestroyed() || !viewerState.mateMode) return null;
  const from = viewerWin.getBounds();
  const base = (!viewerState.mateExpanded ? from : (mateBounds || from));
  const wa = workAreaForBounds(base);
  const expanded = !!opts.expanded;
  const maxPetW = Math.round(wa.width * 1.25);
  const maxPetH = Math.round(wa.height * 1.35);
  const targetW = Math.min(Math.max(180, Math.round(opts.width || base.width)), expanded ? wa.width : maxPetW);
  const targetH = Math.min(Math.max(220, Math.round(opts.height || base.height)), expanded ? wa.height : maxPetH);
  const ax = typeof opts.anchorX === 'number' ? opts.anchorX : 0.5;
  const ay = typeof opts.anchorY === 'number' ? opts.anchorY : 0.75;

  let next;
  if (expanded) {
    // Expand around the compact character bounds so the character stays at the exact same screen coordinates.
    mateBounds = {
      x: base.x,
      y: base.y,
      width: Math.min(Math.max(180, Math.round(opts.petWidth || base.width)), maxPetW),
      height: Math.min(Math.max(220, Math.round(opts.petHeight || base.height)), maxPetH),
    };
    const charCx = mateBounds.x + mateBounds.width * 0.5;
    const charCy = mateBounds.y + mateBounds.height * 0.5;
    next = clampToWorkArea({
      x: Math.round(charCx - targetW * 0.5),
      y: Math.round(charCy - targetH * 0.5),
      width: targetW,
      height: targetH,
    }, wa);
    viewerState.mateExpanded = true;
  } else if (opts.restoreOnly) {
    if (!viewerState.mateExpanded) {
      return null;
    }
    next = clampPetBounds(mateBounds || from, wa);
    viewerState.mateExpanded = false;
    mateBounds = next;
    store.set('window.mate', mateBounds);
  } else {
    const ref = viewerState.mateExpanded && mateBounds ? mateBounds : from;
    const pivotX = ref.x + ref.width * ax;
    const pivotY = ref.y + ref.height * ay;
    next = clampPetBounds({
      x: Math.round(pivotX - targetW * ax),
      y: Math.round(pivotY - targetH * ay),
      width: targetW,
      height: targetH,
    }, wa);
    viewerState.mateExpanded = false;
    mateBounds = next;
    store.set('window.mate', mateBounds);
  }
  viewerWin.setBounds(next, false);
  viewerWin.setResizable(false);
  syncNativeWindowTraits();
  const actual = viewerWin.getBounds();
  if (!viewerState.mateExpanded) {
    mateBounds = actual;
  }
  const petRef = mateBounds || actual;
  const charOffset = {
    x: (petRef.x + petRef.width * 0.5) - (actual.x + actual.width * 0.5),
    y: (petRef.y + petRef.height * 0.5) - (actual.y + actual.height * 0.5),
  };
  return { from, to: actual, petBounds: petRef, charOffset, workArea: wa };
}

function setIgnore(ignore) {
  if (!viewerWin || viewerState.ignoring === ignore) return;
  viewerState.ignoring = ignore;
  viewerWin.setIgnoreMouseEvents(ignore, { forward: true });
}

let cursorTimer = null;
function updateCursorPolling() {
  const need = !!viewerWin && (viewerState.wantCursor || viewerState.transparent || viewerState.mateMode);
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

  ipcMain.on('win:set-transparent', (e, opts) => {
    const { centerOn: _c, offset: _o, ...rest } = opts || {};
    Object.assign(viewerState, rest);
    const transition = applyTransparentMode();
    updateCursorPolling();
    e.returnValue = transition;
  });
  ipcMain.on('win:set-mate-mode', (e, opts) => {
    const { mateMode, ...rest } = opts || {};
    Object.assign(viewerState, rest);
    const transition = applyMateMode(!!mateMode);
    updateCursorPolling();
    e.returnValue = transition;
  });
  ipcMain.on('win:resize-mate', (e, opts) => {
    e.returnValue = resizeMateWindow(opts || {});
  });
  ipcMain.on('win:set-ignore-mouse', (_e, ignore) => {
    if (!viewerState.transparent && !viewerState.mateMode) ignore = false;
    setIgnore(!!ignore);
  });
  ipcMain.on('win:want-cursor', (_e, want) => {
    viewerState.wantCursor = !!want;
    updateCursorPolling();
  });
  ipcMain.on('win:move-by', (_e, dx, dy) => {
    if (!viewerWin) return;
    const [x, y] = viewerWin.getPosition();
    const nx = Math.round(x + dx);
    const ny = Math.round(y + dy);
    viewerWin.setPosition(nx, ny);
    if (viewerState.mateMode && mateBounds) {
      if (viewerState.mateExpanded) {
        mateBounds.x = Math.round(mateBounds.x + dx);
        mateBounds.y = Math.round(mateBounds.y + dy);
      } else {
        mateBounds.x = nx;
        mateBounds.y = ny;
      }
      store.set('window.mate', mateBounds);
    }
  });
  // Windows cannot resize a transparent window by its edges; the settings menu sets the size instead.
  ipcMain.on('win:set-size', (_e, width, height) => {
    if (!viewerWin) return;
    const w = Math.round(width), h = Math.round(height);
    if (viewerState.mateMode) {
      resizeMateWindow({ width: w, height: h, expanded: false });
      return;
    }
    viewerWin.setSize(w, h);
    studioBounds = viewerWin.getBounds();
    store.set('window.viewer', studioBounds);
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

  // Autonomous broadcast (beta): idle until the viewer turns it on; a failure here must not stop the app.
  try {
    autocast = require('./autocast');
    autocast.register(sendViewer);
  } catch (err) {
    autocast = null;
    console.error('[autocast] unavailable', err);
  }
}
let autocast = null;

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
  screen.on('display-metrics-changed', () => {
    if (!viewerWin || viewerWin.isDestroyed() || !viewerState.mateMode) return;
    const cur = viewerWin.getBounds();
    const wa = workAreaForBounds(cur);
    const next = viewerState.mateExpanded ? clampToWorkArea(cur, wa) : clampPetBounds(cur, wa);
    viewerWin.setBounds(next, false);
    viewerWin.setResizable(false);
    syncNativeWindowTraits();
  });
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
  if (autocast) autocast.shutdown();
  store.flush();
});

// Open files dropped on the dock icon / Finder "Open With".
app.on('open-file', (e, filePath) => {
  e.preventDefault();
  if (viewerWin) sendViewer('menu:open-path', filePath);
  else app.once('browser-window-created', () => setTimeout(() => sendViewer('menu:open-path', filePath), 1500));
});
