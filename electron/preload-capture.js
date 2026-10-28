// Bridge for the capture window: VMC / VRChat OSC sending and iFacialMocap receiving.
const { contextBridge, ipcRenderer } = require('electron');
const dgram = require('node:dgram');

let sendSocket = null;
function getSendSocket() {
  if (!sendSocket) {
    sendSocket = dgram.createSocket('udp4');
    sendSocket.on('error', () => { /* sending errors are reported per call */ });
  }
  return sendSocket;
}

let ifmSocket = null;

contextBridge.exposeInMainWorld('vav', {
  platform: process.platform,
  store: {
    all: () => ipcRenderer.sendSync('store:get-all'),
    set: (key, value) => ipcRenderer.send('store:set', key, value),
  },
  requestMedia: (kind) => ipcRenderer.invoke('media:request', kind),
  openViewer: () => ipcRenderer.invoke('viewer:open'),
  setLanguage: (lang) => ipcRenderer.send('app:set-language', lang),
  udp: {
    send: (host, port, data) => new Promise((resolve) => {
      try {
        getSendSocket().send(data, port, host, (err) => resolve(err ? (err.code || String(err)) : null));
      } catch (err) {
        resolve(String(err.message || err));
      }
    }),
    sendMany: (host, port, packets) => {
      const s = getSendSocket();
      for (const p of packets) {
        try { s.send(p, port, host); } catch { /* ignore */ }
      }
    },
  },
  ifm: {
    // iFacialMocap streams to UDP 49983 on the PC once it receives the key string.
    start: (port, onPacket, onError) => new Promise((resolve) => {
      if (ifmSocket) { resolve({ ok: true }); return; }
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: false });
      let settled = false;
      sock.on('message', (msg, rinfo) => onPacket(msg.toString('utf8'), rinfo.address));
      sock.on('error', (err) => {
        if (!settled) { settled = true; try { sock.close(); } catch { /* ignore */ } resolve({ ok: false, error: err.code || String(err) }); return; }
        if (onError) onError(err.code || String(err));
      });
      sock.bind(port, '0.0.0.0', () => {
        settled = true;
        ifmSocket = sock;
        resolve({ ok: true });
      });
    }),
    handshake: (ip, port, message) => {
      if (!ifmSocket) return;
      try { ifmSocket.send(Buffer.from(message, 'utf8'), port, ip); } catch { /* ignore */ }
    },
    stop: () => {
      if (ifmSocket) { try { ifmSocket.close(); } catch { /* ignore */ } }
      ifmSocket = null;
    },
  },
});
