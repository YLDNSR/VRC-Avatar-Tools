// Autonomous broadcast (beta): speech synthesis (macOS `say` or a local TTS server), local LLM
// requests (Ollama / OpenAI-compatible servers) and CHZZK chat through the official Open API.
// Nothing here runs until the viewer asks for it. The CHZZK client secret and tokens stay in this
// process, encrypted with the system keychain (safeStorage); the viewer only learns whether they exist.
const { app, ipcMain, shell, safeStorage } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

// Development only: VAV_CHZZK_MOCK=http://127.0.0.1:port points the CHZZK calls at a local test server.
const MOCK = !app.isPackaged && process.env.VAV_CHZZK_MOCK ? process.env.VAV_CHZZK_MOCK.replace(/\/+$/, '') : '';
const CHZZK_API = MOCK || 'https://openapi.chzzk.naver.com';
const CHZZK_AUTHORIZE = MOCK ? `${MOCK}/account-interlock` : 'https://chzzk.naver.com/account-interlock';
const REDIRECT_PORT = 39780;
const REDIRECT_PATH = '/chzzk/callback';
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}${REDIRECT_PATH}`;

let send = () => {};

function withTimeout(ms, signal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), ms);
  if (signal) signal.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true });
  return { signal: ctrl.signal, done: () => clearTimeout(timer) };
}

async function fetchTimeout(url, opts, ms, signal) {
  const t = withTimeout(ms, signal);
  try {
    return await fetch(url, { ...opts, signal: t.signal });
  } finally {
    t.done();
  }
}

function errText(err) {
  if (!err) return 'unknown';
  if (err.name === 'AbortError' || err.message === 'timeout') return err.message === 'timeout' ? 'timeout' : 'cancelled';
  const cause = err.cause && (err.cause.code || err.cause.message);
  return cause ? `${err.message} (${cause})` : String(err.message || err);
}

// ---------------------------------------------------------------------------
// Speech

function sayVoices() {
  if (process.platform !== 'darwin') return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile('say', ['-v', '?'], { maxBuffer: 1 << 20 }, (err, out) => {
      if (err) { resolve([]); return; }
      const voices = [];
      for (const line of String(out).split('\n')) {
        // "Yuna                ko_KR    # 안녕하세요…" / "Eddy (한국어(한국))      ko_KR    # …"
        const m = /^(.+?)\s{2,}([a-z]{2,3}[_-][A-Za-z0-9]+)\s+#\s?(.*)$/.exec(line.trim());
        if (m) voices.push({ name: m[1].trim(), locale: m[2], sample: m[3] });
      }
      resolve(voices);
    });
  });
}

async function saySynth(text, voice, rate) {
  if (process.platform !== 'darwin') throw new Error('unsupported');
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vav-say-'));
  try {
    // Text from a file, so chat text can never be read as a command-line option.
    const input = path.join(dir, 'in.txt');
    const output = path.join(dir, 'out.wav');
    await fs.promises.writeFile(input, String(text).slice(0, 600), 'utf8');
    const args = ['-f', input, '-o', output, '--file-format=WAVE', '--data-format=LEI16@24000'];
    if (voice) args.unshift('-v', String(voice));
    if (rate) args.unshift('-r', String(Math.round(rate)));
    await new Promise((resolve, reject) => {
      execFile('say', args, { timeout: 30000 }, (err, _out, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve()));
    });
    return await fs.promises.readFile(output);
  } finally {
    fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** POSTs JSON to a local TTS server (e.g. an OpenAI-compatible /v1/audio/speech) and returns the audio. */
async function httpTts(url, body) {
  if (!/^https?:\/\//i.test(String(url))) throw new Error('bad-url');
  const res = await fetchTimeout(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  }, 180000);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Local LLM

const llmRequests = new Map();
/** Ollama servers / models that reject the think field (asked again without it once, then remembered) */
const noThink = new Set();

function apiUrl(base, api, suffix) {
  let b = String(base || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(b)) throw new Error('bad-url');
  if (api === 'openai') {
    if (!/\/v1$/.test(b)) b += '/v1';
    return b + suffix;
  }
  return b + suffix;
}

function stripThink(s) {
  return String(s || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*<\/think>/i, '').trim();
}

async function llmChat(req) {
  const { id, api, url, model, messages } = req;
  const temperature = Number.isFinite(req.temperature) ? req.temperature : 0.8;
  const maxTokens = req.maxTokens || 200;
  const ctrl = new AbortController();
  if (id) llmRequests.set(id, ctrl);
  try {
    if (api === 'openai') {
      const res = await fetchTimeout(apiUrl(url, api, '/chat/completions'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream: false }),
      }, 120000, ctrl.signal);
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
      const json = JSON.parse(text);
      return stripThink(json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content);
    }
    // Ollama: thinking models (qwen3, …) answer directly with think:false; older servers or models
    // without thinking reject the field, so ask again without it.
    const body = { model, messages, stream: false, keep_alive: '30m', options: { temperature, num_predict: maxTokens } };
    const key = `${url}|${model}`;
    for (const think of noThink.has(key) ? [undefined] : [false, undefined]) {
      const res = await fetchTimeout(apiUrl(url, api, '/api/chat'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(think === undefined ? body : { ...body, think }),
      }, 120000, ctrl.signal);
      const text = await res.text();
      if (!res.ok) {
        if (think === false && /think/i.test(text)) { noThink.add(key); continue; }
        throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
      }
      const json = JSON.parse(text);
      return stripThink(json.message && json.message.content);
    }
    return '';
  } finally {
    if (id) llmRequests.delete(id);
  }
}

async function llmModels(api, url) {
  const res = await fetchTimeout(apiUrl(url, api, api === 'openai' ? '/models' : '/api/tags'), {}, 5000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (api === 'openai') return (json.data || []).map((m) => m.id).filter(Boolean);
  return (json.models || []).map((m) => m.name || m.model).filter(Boolean);
}

// ---------------------------------------------------------------------------
// CHZZK: credentials (encrypted), OAuth login, chat session

function secretsFile() {
  return path.join(app.getPath('userData'), 'autocast-secrets.json');
}

function loadSecrets() {
  try { return JSON.parse(fs.readFileSync(secretsFile(), 'utf8')) || {}; } catch { return {}; }
}

function saveSecrets(s) {
  fs.mkdirSync(path.dirname(secretsFile()), { recursive: true });
  fs.writeFileSync(secretsFile(), JSON.stringify(s, null, 2), { mode: 0o600 });
}

function enc(v) {
  if (!v) return '';
  if (!safeStorage.isEncryptionAvailable()) throw new Error('keychain-unavailable');
  return safeStorage.encryptString(String(v)).toString('base64');
}

function dec(v) {
  if (!v) return '';
  try { return safeStorage.decryptString(Buffer.from(v, 'base64')); } catch { return ''; }
}

async function chzzkApi(method, pathname, { token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetchTimeout(CHZZK_API + pathname, { method, headers, body: body ? JSON.stringify(body) : undefined }, 15000);
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  if (!res.ok || (json && typeof json.code === 'number' && json.code !== 200)) {
    throw new Error(`CHZZK ${res.status}${json && json.message ? `: ${json.message}` : ''}`);
  }
  return json ? json.content : null;
}

function storeTokens(s, tok) {
  s.accessToken = enc(tok.accessToken);
  s.refreshToken = enc(tok.refreshToken);
  s.expiresAt = Date.now() + (Number(tok.expiresIn) || 86400) * 1000;
}

async function accessToken() {
  const s = loadSecrets();
  const access = dec(s.accessToken);
  if (access && s.expiresAt && s.expiresAt - Date.now() > 5 * 60 * 1000) return access;
  const refresh = dec(s.refreshToken);
  const secret = dec(s.clientSecret);
  if (!refresh || !s.clientId || !secret) throw new Error('not-logged-in');
  // Refresh tokens are single use: the new pair replaces the old one right away.
  const tok = await chzzkApi('POST', '/auth/v1/token', {
    body: { grantType: 'refresh_token', refreshToken: refresh, clientId: s.clientId, clientSecret: secret },
  });
  storeTokens(s, tok);
  saveSecrets(s);
  return tok.accessToken;
}

function chzzkState() {
  const s = loadSecrets();
  return {
    clientId: s.clientId || '',
    hasSecret: !!s.clientSecret,
    loggedIn: !!s.refreshToken,
    channelName: s.channelName || '',
    redirectUri: REDIRECT_URI,
    keychain: safeStorage.isEncryptionAvailable(),
    connection: conn.state,
  };
}

function setClient(clientId, clientSecret) {
  const s = loadSecrets();
  const id = String(clientId || '').trim();
  if (id !== s.clientId) {
    // Another app: its tokens do not belong to the new client.
    delete s.accessToken; delete s.refreshToken; delete s.expiresAt; delete s.channelName; delete s.channelId;
  }
  s.clientId = id;
  if (clientSecret) s.clientSecret = enc(String(clientSecret).trim());
  saveSecrets(s);
  return chzzkState();
}

let login = null;

function stopLogin() {
  if (!login) return;
  clearTimeout(login.timer);
  for (const srv of login.servers) try { srv.close(); } catch { /* ignore */ }
  login = null;
}

const CALLBACK_PAGE = (ok) => `<!doctype html><meta charset="utf-8"><title>VRC Avatar Tools</title>
<body style="font-family:-apple-system,sans-serif;background:#1d1f24;color:#eee;display:grid;place-items:center;height:90vh">
<div style="text-align:center"><h2>${ok ? '치지직 연결 완료' : '치지직 연결 실패'}</h2>
<p>${ok ? '이 창을 닫고 앱으로 돌아가세요. / You can close this window.' : '앱에서 다시 시도해 주세요. / Please try again from the app.'}</p></div>`;

async function chzzkLogin() {
  const s = loadSecrets();
  const secret = dec(s.clientSecret);
  if (!s.clientId || !secret) throw new Error('no-client');
  stopLogin();
  const state = crypto.randomBytes(16).toString('hex');
  const code = await new Promise((resolve, reject) => {
    const onRequest = (req, res) => {
      const u = new URL(req.url || '/', REDIRECT_URI);
      if (u.pathname !== REDIRECT_PATH) { res.writeHead(404); res.end(); return; }
      const got = u.searchParams.get('code');
      const ok = !!got && u.searchParams.get('state') === state;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(CALLBACK_PAGE(ok));
      if (ok) resolve(got); else reject(new Error('login-denied'));
    };
    // The browser may resolve "localhost" to either address; listen on both loopbacks only.
    const servers = ['127.0.0.1', '::1'].map((host) => {
      const srv = http.createServer(onRequest);
      srv.on('error', (err) => { if (host === '127.0.0.1') reject(new Error(err.code === 'EADDRINUSE' ? 'port-busy' : errText(err))); });
      srv.listen(REDIRECT_PORT, host);
      return srv;
    });
    login = { servers, timer: setTimeout(() => reject(new Error('timeout')), 5 * 60 * 1000) };
    const q = new URLSearchParams({ clientId: s.clientId, redirectUri: REDIRECT_URI, state });
    const authorize = `${CHZZK_AUTHORIZE}?${q}`;
    if (MOCK) fetch(authorize).catch(() => {}); else shell.openExternal(authorize);
  }).finally(stopLogin);
  const tok = await chzzkApi('POST', '/auth/v1/token', {
    body: { grantType: 'authorization_code', clientId: s.clientId, clientSecret: secret, code, state },
  });
  storeTokens(s, tok);
  try {
    const me = await chzzkApi('GET', '/open/v1/users/me', { token: tok.accessToken });
    s.channelId = (me && me.channelId) || '';
    s.channelName = (me && me.channelName) || '';
  } catch { /* the app may not have the user-info scope */ }
  saveSecrets(s);
  return chzzkState();
}

async function chzzkLogout() {
  chzzkDisconnect();
  const s = loadSecrets();
  const secret = dec(s.clientSecret);
  const refresh = dec(s.refreshToken);
  if (refresh && s.clientId && secret) {
    await chzzkApi('POST', '/auth/v1/token/revoke', {
      body: { clientId: s.clientId, clientSecret: secret, token: refresh, tokenTypeHint: 'refresh_token' },
    }).catch(() => {});
  }
  delete s.accessToken; delete s.refreshToken; delete s.expiresAt; delete s.channelName; delete s.channelId;
  saveSecrets(s);
  return chzzkState();
}

// Chat session: Socket.IO 2 (Engine.IO 3) over a WebSocket, as the CHZZK session server expects.
const conn = { state: 'idle', want: false, ws: null, ping: null, retry: null, attempts: 0, lastSeen: 0 };

function setConn(state, message) {
  conn.state = state;
  send('autocast:chzzk-status', { state, message: message || '' });
}

function closeSocket() {
  clearInterval(conn.ping);
  conn.ping = null;
  if (conn.ws) {
    const ws = conn.ws;
    conn.ws = null;
    ws.onclose = null;
    try { ws.close(); } catch { /* ignore */ }
  }
}

function scheduleReconnect(reason) {
  closeSocket();
  if (!conn.want) { setConn('idle'); return; }
  clearTimeout(conn.retry);
  const delay = Math.min(60, 5 * 2 ** Math.min(conn.attempts, 4));
  conn.attempts++;
  setConn('reconnecting', `${reason || ''} (${delay}s)`.trim());
  conn.retry = setTimeout(() => openSession().catch((err) => scheduleReconnect(errText(err))), delay * 1000);
}

async function openSession() {
  closeSocket();
  setConn('connecting');
  const token = await accessToken();
  const session = await chzzkApi('GET', '/open/v1/sessions/auth', { token });
  if (!conn.want) return;
  const u = new URL(session.url);
  const q = new URLSearchParams(u.search);
  q.set('EIO', '3');
  q.set('transport', 'websocket');
  const ws = new WebSocket(`${u.protocol === 'http:' ? 'ws' : 'wss'}://${u.host}/socket.io/?${q}`);
  conn.ws = ws;
  conn.lastSeen = Date.now();
  ws.onmessage = (ev) => {
    conn.lastSeen = Date.now();
    onPacket(ws, String(ev.data));
  };
  ws.onerror = () => {};
  ws.onclose = () => { if (conn.ws === ws) scheduleReconnect('closed'); };
}

function onPacket(ws, p) {
  switch (p[0]) {
    case '0': { // open: { sid, pingInterval, pingTimeout }
      let o = {};
      try { o = JSON.parse(p.slice(1)); } catch { /* defaults */ }
      const interval = o.pingInterval || 25000;
      const timeout = o.pingTimeout || 60000;
      clearInterval(conn.ping);
      conn.ping = setInterval(() => {
        if (Date.now() - conn.lastSeen > interval + timeout) { scheduleReconnect('timeout'); return; }
        try { ws.send('2'); } catch { /* closing */ }
      }, interval);
      break;
    }
    case '2': try { ws.send('3'); } catch { /* closing */ } break;
    case '4': onSocketIo(p.slice(1)); break;
    case '1': scheduleReconnect('server-closed'); break;
    default: break;
  }
}

function onSocketIo(p) {
  if (p[0] === '2') {
    let i = 1;
    if (p[i] === '/') i = p.indexOf(',', i) + 1;
    while (i < p.length && p[i] >= '0' && p[i] <= '9') i++;
    try {
      const [name, data] = JSON.parse(p.slice(i));
      onEvent(name, data).catch((err) => setConn('error', errText(err)));
    } catch { /* not an event */ }
  } else if (p[0] === '4') {
    setConn('error', p.slice(1, 200));
  }
}

async function onEvent(name, data) {
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { /* keep text */ } }
  if (name === 'SYSTEM') {
    const type = data && data.type;
    if (type === 'connected') {
      const sessionKey = data.data && data.data.sessionKey;
      await chzzkApi('POST', `/open/v1/sessions/events/subscribe/chat?sessionKey=${encodeURIComponent(sessionKey)}`, { token: await accessToken() });
    } else if (type === 'subscribed') {
      conn.attempts = 0;
      setConn('connected');
    } else if (type === 'revoked' || type === 'unsubscribed') {
      setConn('error', type);
    }
    return;
  }
  if (name === 'CHAT' && data && typeof data === 'object') {
    send('autocast:chat', {
      id: crypto.randomUUID(),
      nickname: (data.profile && data.profile.nickname) || '',
      role: data.userRoleCode || 'common_user',
      content: String(data.content || ''),
      time: data.messageTime || Date.now(),
      senderChannelId: data.senderChannelId || '',
    });
  }
}

async function chzzkConnect() {
  conn.want = true;
  conn.attempts = 0;
  clearTimeout(conn.retry);
  try {
    await openSession();
  } catch (err) {
    conn.want = false;
    closeSocket();
    setConn('error', errText(err));
    throw err;
  }
  return chzzkState();
}

function chzzkDisconnect() {
  conn.want = false;
  clearTimeout(conn.retry);
  closeSocket();
  setConn('idle');
  return chzzkState();
}

// ---------------------------------------------------------------------------

function register(sendViewer) {
  send = sendViewer;
  // Every handler answers { ok: true, … } or { ok: false, error } instead of throwing across IPC.
  const handle = (channel, fn) => ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  });
  handle('autocast:say-voices', () => sayVoices());
  handle('autocast:say', (text, voice, rate) => saySynth(text, voice, rate));
  handle('autocast:tts-http', (url, body) => httpTts(url, body));
  handle('autocast:llm', (req) => llmChat(req || {}));
  ipcMain.on('autocast:llm-cancel', (_e, id) => { const c = llmRequests.get(id); if (c) c.abort(new Error('cancelled')); });
  handle('autocast:llm-models', (api, url) => llmModels(api, url));
  handle('autocast:chzzk-state', () => chzzkState());
  handle('autocast:chzzk-set-client', (id, secret) => setClient(id, secret));
  handle('autocast:chzzk-login', () => chzzkLogin());
  handle('autocast:chzzk-logout', () => chzzkLogout());
  handle('autocast:chzzk-connect', () => chzzkConnect());
  handle('autocast:chzzk-disconnect', () => chzzkDisconnect());
}

function shutdown() {
  stopLogin();
  conn.want = false;
  clearTimeout(conn.retry);
  closeSocket();
  for (const c of llmRequests.values()) c.abort(new Error('cancelled'));
}

module.exports = { register, shutdown };
