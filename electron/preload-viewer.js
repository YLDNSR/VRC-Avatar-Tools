// Bridge between the viewer page and the main process / Node networking.
const { contextBridge, ipcRenderer, webUtils } = require('electron');
const dgram = require('node:dgram');
const path = require('node:path');
const fs = require('node:fs');

// The native addon writes Syphon frames straight into shared memory from this process.
let native = null;
for (const p of [
  path.join(__dirname, '..', 'native', 'build', 'Release', 'vav_native.node'),
  path.join(process.resourcesPath || '', 'app.asar.unpacked', 'native', 'build', 'Release', 'vav_native.node'),
]) {
  try { if (fs.existsSync(p)) { native = require(p); break; } } catch (err) { console.error('native addon', err); }
}

const sockets = new Map();
let nextSocketId = 1;

function fileUrl(p) {
  // Windows paths (C:\Users\...) become /C:/Users/... ; the main process strips the leading slash again.
  if (process.platform === 'win32') p = '/' + p.replace(/\\/g, '/');
  return 'vavfile://local' + p.split('/').map(encodeURIComponent).join('/');
}

const allowedEvents = new Set([
  'cursor', 'gesture-key', 'avatar:changed', 'menu:open-avatar', 'menu:open-path', 'win:minimized', 'win:focus', 'syphon:exited',
]);

contextBridge.exposeInMainWorld('vav', {
  platform: process.platform,
  store: {
    all: () => ipcRenderer.sendSync('store:get-all'),
    set: (key, value) => ipcRenderer.send('store:set', key, value),
  },
  dialog: {
    openAvatar: () => ipcRenderer.invoke('dialog:open-avatar'),
    openFolder: (defaultPath) => ipcRenderer.invoke('dialog:open-folder', defaultPath),
    openAnimations: (multi) => ipcRenderer.invoke('dialog:open-animations', multi),
  },
  fs: {
    readText: (p) => ipcRenderer.invoke('fs:read-text', p),
    exists: (p) => ipcRenderer.invoke('fs:exists', p),
    stat: (p) => ipcRenderer.invoke('fs:stat', p),
  },
  fileUrl,
  pathForFile: (file) => webUtils.getPathForFile(file),
  listFolder: (dir) => ipcRenderer.invoke('avatars:list-folder', dir),
  watchAvatar: (p) => ipcRenderer.send('avatar:watch', p),
  profiles: {
    list: () => ipcRenderer.invoke('profiles:list'),
    openFolder: () => ipcRenderer.invoke('profiles:open-folder'),
  },
  sysInfo: () => ipcRenderer.invoke('sys:info'),
  win: {
    setTransparent: (opts) => ipcRenderer.send('win:set-transparent', opts),
    setIgnoreMouse: (ignore) => ipcRenderer.send('win:set-ignore-mouse', ignore),
    wantCursor: (want) => ipcRenderer.send('win:want-cursor', want),
    moveBy: (dx, dy) => ipcRenderer.send('win:move-by', dx, dy),
    close: () => ipcRenderer.send('win:close'),
    setSize: (width, height) => ipcRenderer.send('win:set-size', width, height),
    getSize: () => ipcRenderer.invoke('win:get-size'),
    minimize: () => ipcRenderer.send('win:minimize'),
  },
  syphon: {
    start: async (name) => {
      if (!native) return false;
      const r = await ipcRenderer.invoke('syphon:start', name);
      return !!(r && r.ok && native.shmOpen(r.shmPath));
    },
    stop: async () => {
      if (native) native.shmClose();
      return ipcRenderer.invoke('syphon:stop');
    },
    status: async () => {
      if (!native) return { available: false, running: false, clients: false };
      const s = native.shmStatus();
      return { available: true, running: !!s.open, ready: !!s.ready, clients: !!s.clients };
    },
    sendFrame: (data, width, height) => (native ? native.shmWrite(data, width, height) : false),
  },
  keys: {
    setGlobal: (enable) => ipcRenderer.invoke('keys:set-global', enable),
  },
  login: {
    get: () => ipcRenderer.invoke('login:get'),
    set: (enable) => ipcRenderer.invoke('login:set', enable),
    openSettings: () => ipcRenderer.invoke('login:open-settings'),
  },
  openCapture: () => ipcRenderer.invoke('capture:open'),
  setLanguage: (lang) => ipcRenderer.send('app:set-language', lang),
  quit: () => ipcRenderer.send('app:quit'),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  on: (channel, cb) => {
    if (!allowedEvents.has(channel)) return;
    ipcRenderer.on(channel, (_e, ...args) => cb(...args));
  },
  udp: {
    // Opens a UDP listener. onPacket(Uint8Array, address) / onError(message)
    listen: (port, onPacket, onError) => new Promise((resolve) => {
      const id = nextSocketId++;
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: false });
      let settled = false;
      sock.on('message', (msg, rinfo) => onPacket(new Uint8Array(msg), rinfo.address));
      sock.on('error', (err) => {
        if (!settled) { settled = true; sock.close(); resolve({ ok: false, error: err.code || String(err) }); return; }
        if (onError) onError(err.code || String(err));
      });
      sock.bind(port, '0.0.0.0', () => {
        settled = true;
        sockets.set(id, sock);
        resolve({ ok: true, id });
      });
    }),
    close: (id) => {
      const s = sockets.get(id);
      if (s) { try { s.close(); } catch { /* ignore */ } sockets.delete(id); }
    },
  },
});
