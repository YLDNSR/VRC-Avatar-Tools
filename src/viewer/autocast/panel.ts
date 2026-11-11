// "자율 방송" panel: start / stop, the live console (chat, what the avatar said, operator speech, test
// chat) and the settings for CHZZK, answers, voice and motion.
import type { App } from '../app';
import { h, clear, toggle, select, slider, segmented, numberInput, textInput, toast } from '../../shared/dom';
import { panelShell, section, button } from '../ui/common';
import { autocast, DEFAULT_PERSONA, DEFAULT_IDLE_LINES, type ReplyMode } from './settings';
import type { Brain, ChatRole, LogLine } from './brain';
import type { Speaker } from './speaker';
import type { ChzzkLink } from './chzzk';
import { GESTURES } from '../mate/actions';
import type { LifeMotion } from '../mate/life';
import { actionButtons } from '../mate/panel';
import { mate } from '../mate/settings';
import { tm } from '../mate/strings';
import { frameUpperBody } from './framing';
import { tc } from './strings';
import type { ViewerBridge, SayVoice } from '../../shared/bridge';

const vav = (window as any).vav as ViewerBridge;

type Tab = 'live' | 'chzzk' | 'reply' | 'voice' | 'motion';

export interface CastControl {
  brain: Brain;
  speaker: Speaker;
  chzzk: ChzzkLink;
  life: LifeMotion;
  start(): void;
  stop(): void;
}

function textArea(value: string, onChange: (v: string) => void, rows = 3, placeholder = '') {
  const el = h('textarea', { class: 'cast-textarea', rows: String(rows), placeholder, spellcheck: false }) as HTMLTextAreaElement;
  el.value = value;
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

function hint(text: string) {
  return h('div', { class: 'muted small cast-hint' }, text);
}

/** One small button per reaction gesture (also works before the broadcast starts). */
function gestureButtons(app: App, life: LifeMotion) {
  return actionButtons(app, life, GESTURES);
}

export function createAutocastPanel(app: App, c: CastControl) {
  const shell = panelShell(tc('title'), () => app.togglePanel('autocast'), 'autocast-panel');
  let tab: Tab = 'live';
  const pages: Record<Tab, HTMLElement> = {
    live: h('div'), chzzk: h('div'), reply: h('div'), voice: h('div'), motion: h('div'),
  };
  const tabs = segmented<Tab>([
    { value: 'live', label: tc('tab.live') },
    { value: 'chzzk', label: tc('tab.chzzk') },
    { value: 'reply', label: tc('tab.reply') },
    { value: 'voice', label: tc('tab.voice') },
    { value: 'motion', label: tc('tab.motion') },
  ], tab, (v) => { tab = v; showTab(); });
  function showTab() {
    for (const [k, el] of Object.entries(pages)) el.classList.toggle('hidden', k !== tab);
    if (tab === 'chzzk') refreshChzzk();
    if (tab === 'voice') loadVoices();
    refresh();
  }

  // -------------------------------------------------------------------------
  // Live: start / stop, status, console

  const startBtn = button(tc('start'), () => {
    if (c.brain.running) c.stop(); else c.start();
    refresh();
  }, 'primary cast-start');
  const status = h('div', { class: 'cast-status' });
  const pause = toggle(tc('pause'), false, (v) => { c.brain.setPaused(v); refresh(); }, tc('pauseHint'));
  const logEl = h('div', { class: 'cast-log' });
  const say = textArea('', () => {}, 2, tc('operator.placeholder'));
  const sayNow = () => {
    const text = say.value.trim();
    if (!text) return;
    if (!c.brain.running) { toast(tc('needStart')); return; }
    c.speaker.unlock();
    c.brain.say(text);
    say.value = '';
  };
  say.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sayNow(); }
  });
  const testNick = h('input', { type: 'text', class: 'cast-test-nick', value: tc('test.viewer'), spellcheck: false }) as HTMLInputElement;
  const testRole = h('select', { class: 'cast-test-role' },
    h('option', { value: 'viewer' }, tc('role.viewer')),
    h('option', { value: 'streamer' }, tc('role.streamer'))) as HTMLSelectElement;
  const testText = h('input', { type: 'text', placeholder: tc('test.placeholder'), spellcheck: false }) as HTMLInputElement;
  const sendTest = () => {
    const text = testText.value.trim();
    if (!text) return;
    c.brain.receive({ nick: testNick.value.trim() || tc('test.viewer'), text, role: testRole.value as ChatRole, source: 'test' });
    testText.value = '';
  };
  testText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); sendTest(); }
  });

  pages.live.append(
    startBtn,
    status,
    pause.el,
    h('div', { class: 'button-row' },
      button(tc('frame'), () => { if (!frameUpperBody(app)) toast(tc('needAvatar')); }),
      button(tc('skip'), () => c.brain.skip()),
      button(tc('obs'), () => app.togglePanel('streaming')),
    ),
    gestureButtons(app, c.life),
    logEl,
    h('div', { class: 'cast-say' }, say, button(tc('operator.say'), sayNow, 'primary')),
    hint(tc('operator.hint')),
    h('details', { class: 'cast-test' },
      h('summary', {}, tc('test.title')),
      h('div', { class: 'cast-test-row' }, testNick, testRole),
      h('div', { class: 'cast-test-row' }, testText, button(tc('test.send'), sendTest))),
  );

  const KIND_LABEL: Record<LogLine['kind'], string> = {
    chat: '', speech: tc('log.avatar'), operator: tc('log.operator'), idle: tc('log.idle'), info: '', error: '',
  };
  let logCount = -1;
  let logLast: LogLine | undefined;
  function renderLog(force = false) {
    const log = c.brain.log;
    if (!force && log.length === logCount && log[log.length - 1] === logLast) return;
    const stick = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 30;
    logCount = log.length;
    logLast = log[log.length - 1];
    clear(logEl);
    for (const l of log.slice(-120)) {
      const who = l.kind === 'chat' ? `${l.who || '?'}${l.role === 'streamer' ? ` (${tc('role.streamer')})` : ''}` : KIND_LABEL[l.kind];
      logEl.appendChild(h('div', { class: `cast-line ${l.kind}${l.skipped ? ' skipped' : ''}` },
        who ? h('span', { class: 'who' }, who) : null,
        h('span', { class: 'text' }, l.text)));
    }
    if (c.brain.thinking) logEl.appendChild(h('div', { class: 'cast-line info' }, h('span', { class: 'text' }, tc('log.thinking'))));
    if (stick || force) logEl.scrollTop = logEl.scrollHeight;
  }

  // -------------------------------------------------------------------------
  // CHZZK

  const chz = {
    clientId: h('input', { type: 'text', spellcheck: false, placeholder: 'Client ID' }) as HTMLInputElement,
    secret: h('input', { type: 'password', spellcheck: false, autocomplete: 'off', placeholder: 'Client Secret' }) as HTMLInputElement,
    redirect: h('input', { type: 'text', readonly: true }) as HTMLInputElement,
    state: h('div', { class: 'cast-status' }),
    login: button(tc('chzzk.login'), () => chzzkAction('login')),
    logout: button(tc('chzzk.logout'), () => chzzkAction('logout'), 'ghost'),
    connect: button(tc('chzzk.connect'), () => chzzkAction('connect')),
    disconnect: button(tc('chzzk.disconnect'), () => chzzkAction('disconnect'), 'ghost'),
  };
  const saveClient = button(tc('chzzk.save'), async () => {
    const r = await vav.autocast.chzzk.setClient(chz.clientId.value.trim(), chz.secret.value.trim());
    chz.secret.value = '';
    if (!r.ok) toast(`${tc('chzzk.saveFailed')}: ${r.error === 'keychain-unavailable' ? tc('chzzk.noKeychain') : r.error}`, 6000);
    else toast(tc('chzzk.saved'));
    refreshChzzk();
  });
  async function chzzkAction(kind: 'login' | 'logout' | 'connect' | 'disconnect') {
    if (kind === 'login') toast(tc('chzzk.loginBrowser'), 6000);
    const r = await c.chzzk.run(kind);
    if (!r.ok) toast(`${tc('chzzk.failed')}: ${c.chzzk.explain(r.error)}`, 7000);
    refreshChzzk();
  }
  const connectOnStart = toggle(tc('chzzk.connectOnStart'), autocast.chzzk.connectOnStart, (v) => { autocast.chzzk.connectOnStart = v; autocast.save(); });
  const op = autocast.operator;
  const streamerSpeaks = toggle(tc('op.streamerSpeaks'), op.streamerSpeaks, (v) => { op.streamerSpeaks = v; autocast.save(); }, tc('op.streamerSpeaksHint'));
  const prefix = textInput(tc('op.prefix'), op.prefix, (v) => { op.prefix = v; autocast.save(); }, tc('op.prefixPlaceholder'));
  const clearQueue = toggle(tc('op.clearQueue'), op.clearQueue, (v) => { op.clearQueue = v; autocast.save(); });

  pages.chzzk.append(
    hint(tc('chzzk.guide')),
    h('div', { class: 'button-row' }, button(tc('chzzk.devCenter'), () => vav.openExternal('https://developers.chzzk.naver.com/'), 'ghost')),
    h('div', { class: 'row-label' }, tc('chzzk.redirect')),
    h('div', { class: 'cast-copy' }, chz.redirect, button(tc('copy'), () => {
      navigator.clipboard.writeText(chz.redirect.value).then(() => toast(tc('copied'))).catch(() => chz.redirect.select());
    })),
    h('div', { class: 'row-label' }, tc('chzzk.client')),
    chz.clientId,
    chz.secret,
    h('div', { class: 'button-row' }, saveClient),
    chz.state,
    h('div', { class: 'button-row' }, chz.login, chz.logout),
    h('div', { class: 'button-row' }, chz.connect, chz.disconnect),
    connectOnStart.el,
    section(tc('op.title'), streamerSpeaks.el, prefix.el, clearQueue.el, hint(tc('op.hint'))),
  );

  async function refreshChzzk() {
    const r = await vav.autocast.chzzk.state();
    if (!r.ok) return;
    const s = r.value;
    chz.redirect.value = s.redirectUri;
    if (document.activeElement !== chz.clientId) chz.clientId.value = s.clientId;
    chz.secret.placeholder = s.hasSecret ? tc('chzzk.secretSaved') : 'Client Secret';
    const conn = c.chzzk.connection;
    chz.state.textContent = [
      s.loggedIn ? tc('chzzk.loggedIn', { name: s.channelName || '-' }) : tc('chzzk.loggedOut'),
      tc(`chzzk.conn.${conn}`) + (c.chzzk.message ? ` (${c.chzzk.message})` : ''),
      s.keychain ? '' : tc('chzzk.noKeychain'),
    ].filter(Boolean).join(' · ');
    chz.login.disabled = !s.clientId || !s.hasSecret;
    chz.logout.classList.toggle('hidden', !s.loggedIn);
    chz.connect.disabled = !s.loggedIn || conn === 'connected' || conn === 'connecting';
    chz.disconnect.classList.toggle('hidden', conn === 'idle');
  }

  // -------------------------------------------------------------------------
  // Answers and idle talk

  const r = autocast.reply;
  const mode = segmented<ReplyMode>([
    { value: 'llm', label: tc('reply.llm') },
    { value: 'read', label: tc('reply.read') },
    { value: 'off', label: tc('reply.off') },
  ], r.mode, (v) => { r.mode = v; autocast.save(); refresh(); });
  const name = textInput(tc('reply.name'), autocast.name, (v) => { autocast.name = v; autocast.save(); }, tc('reply.namePlaceholder'));
  const persona = textArea(autocast.persona, (v) => { autocast.persona = v.trim() || DEFAULT_PERSONA; autocast.save(); }, 3);
  const llm = autocast.llm;
  const api = select<'ollama' | 'openai'>(tc('llm.api'), [
    { value: 'ollama', label: 'Ollama' },
    { value: 'openai', label: tc('llm.openai') },
  ], llm.api, (v) => {
    llm.api = v;
    if (v === 'ollama' && /:1234/.test(llm.url)) llm.url = 'http://127.0.0.1:11434';
    if (v === 'openai' && /:11434/.test(llm.url)) llm.url = 'http://127.0.0.1:1234/v1';
    url.set(llm.url);
    autocast.save();
    checkLlm();
  });
  const url = textInput(tc('llm.url'), llm.url, (v) => { llm.url = v; autocast.save(); checkLlm(); });
  const model = select<string>(tc('llm.model'), [{ value: llm.model, label: llm.model }], llm.model, (v) => { llm.model = v; autocast.save(); });
  const llmStatus = h('div', { class: 'muted small cast-hint' });
  async function checkLlm() {
    llmStatus.textContent = tc('llm.checking');
    const res = await vav.autocast.llmModels(llm.api, llm.url);
    if (!res.ok) {
      llmStatus.textContent = tc('llm.unreachable', { error: res.error });
      return;
    }
    const list = res.value.includes(llm.model) || !llm.model ? res.value : [llm.model, ...res.value];
    model.setOptions(list.map((m) => ({ value: m, label: m })), llm.model);
    if (!llm.model && list[0]) { llm.model = list[0]; autocast.save(); model.set(llm.model); }
    llmStatus.textContent = res.value.length
      ? (res.value.includes(llm.model) ? tc('llm.ok', { count: res.value.length }) : tc('llm.noModel', { model: llm.model }))
      : tc('llm.empty');
  }
  const temperature = slider({
    label: tc('llm.temperature'), min: 0, max: 1.5, step: 0.05, value: llm.temperature,
    onInput: (v) => { llm.temperature = v; autocast.save(); },
  });
  const history = numberInput(tc('llm.history'), llm.history, (v) => { llm.history = v; autocast.save(); }, { min: 0, max: 20, width: '64px' });
  const maxChars = slider({
    label: tc('reply.maxChars'), min: 30, max: 200, step: 5, value: r.maxChars, format: (v) => `${Math.round(v)}`,
    onInput: (v) => { r.maxChars = Math.round(v); autocast.save(); },
  });
  const gap = slider({
    label: tc('reply.gap'), min: 0, max: 20, step: 0.5, value: r.gapSec, format: (v) => `${v.toFixed(1)}s`,
    onInput: (v) => { r.gapSec = v; autocast.save(); },
  });
  const maxQueue = numberInput(tc('reply.maxQueue'), r.maxQueue, (v) => { r.maxQueue = v; autocast.save(); }, { min: 1, max: 20, width: '64px' });
  const ignore = textInput(tc('reply.ignore'), r.ignorePrefixes, (v) => { r.ignorePrefixes = v; autocast.save(); }, '! /');
  const readFormat = textInput(tc('reply.readFormat'), r.readFormat, (v) => { r.readFormat = v || '{nick}님, {msg}'; autocast.save(); });
  const banned = textArea(r.banned, (v) => { r.banned = v; autocast.save(); }, 2, tc('reply.bannedPlaceholder'));

  const idle = autocast.idle;
  const idleOn = toggle(tc('idle.enabled'), idle.enabled, (v) => { idle.enabled = v; autocast.save(); });
  const idleMin = numberInput(tc('idle.min'), idle.minSec, (v) => { idle.minSec = v; autocast.save(); }, { min: 10, max: 3600, width: '72px' });
  const idleMax = numberInput(tc('idle.max'), idle.maxSec, (v) => { idle.maxSec = v; autocast.save(); }, { min: 10, max: 3600, width: '72px' });
  const idleLlm = toggle(tc('idle.useLlm'), idle.useLlm, (v) => { idle.useLlm = v; autocast.save(); });
  const topics = textInput(tc('idle.topics'), idle.topics, (v) => { idle.topics = v; autocast.save(); });
  const lines = textArea(idle.lines, (v) => { idle.lines = v.trim() ? v : DEFAULT_IDLE_LINES.join('\n'); autocast.save(); }, 4);

  const llmBox = h('div', {},
    section(tc('llm.title'), api.el, url.el, model.el,
      h('div', { class: 'button-row' }, button(tc('llm.check'), checkLlm), button(tc('llm.resetMemory'), () => { c.brain.clearHistory(); toast(tc('llm.memoryCleared')); }, 'ghost')),
      llmStatus, hint(tc('llm.install')), temperature.el, history.el),
  );
  pages.reply.append(
    mode.el,
    hint(tc('reply.modeHint')),
    name.el,
    h('div', { class: 'row-label' }, tc('reply.persona')),
    persona,
    llmBox,
    section(tc('reply.rules'), maxChars.el, gap.el, maxQueue.el, ignore.el, readFormat.el,
      h('div', { class: 'row-label' }, tc('reply.banned')), banned),
    section(tc('idle.title'), idleOn.el, idleMin.el, idleMax.el, idleLlm.el, topics.el,
      h('div', { class: 'row-label' }, tc('idle.lines')), lines, hint(tc('idle.hint'))),
  );

  // -------------------------------------------------------------------------
  // Voice

  const vo = autocast.voice;
  const engine = segmented<'say' | 'http'>([
    { value: 'say', label: tc('voice.say') },
    { value: 'http', label: tc('voice.http') },
  ], vo.engine, (v) => { vo.engine = v; autocast.save(); refresh(); });
  const sayVoice = select<string>(tc('voice.voice'), [{ value: vo.sayVoice, label: vo.sayVoice }], vo.sayVoice, (v) => { vo.sayVoice = v; autocast.save(); });
  const rate = slider({
    label: tc('voice.rate'), min: 100, max: 320, step: 5, value: vo.rate, format: (v) => `${Math.round(v)}`,
    onInput: (v) => { vo.rate = Math.round(v); autocast.save(); },
  });
  const httpUrl = textInput(tc('voice.httpUrl'), vo.httpUrl, (v) => { vo.httpUrl = v; autocast.save(); });
  const httpModel = textInput(tc('voice.httpModel'), vo.httpModel, (v) => { vo.httpModel = v; autocast.save(); }, tc('voice.optional'));
  const httpVoice = textInput(tc('voice.httpVoice'), vo.httpVoice, (v) => { vo.httpVoice = v; autocast.save(); }, tc('voice.optional'));
  const volume = slider({
    label: tc('voice.volume'), min: 0, max: 1.5, step: 0.05, value: vo.volume, format: (v) => `${Math.round(v * 100)}%`,
    onInput: (v) => { vo.volume = v; autocast.save(); },
  });
  const output = select<string>(tc('voice.output'), [{ value: '', label: tc('voice.default') }], vo.sinkId, (v) => {
    vo.sinkId = v;
    autocast.save();
    c.speaker.applyOutput();
  });
  const testLine = h('input', { type: 'text', value: tc('voice.testLine'), spellcheck: false }) as HTMLInputElement;
  const sayBox = h('div', {}, sayVoice.el, rate.el);
  const httpBox = h('div', {}, httpUrl.el, httpModel.el, httpVoice.el, hint(tc('voice.httpHint')));
  pages.voice.append(
    engine.el,
    sayBox,
    httpBox,
    volume.el,
    output.el,
    hint(tc('voice.obsHint')),
    h('div', { class: 'cast-test-row' }, testLine, button(tc('voice.test'), async () => {
      c.speaker.unlock();
      try {
        await c.speaker.speak(testLine.value.trim() || tc('voice.testLine'));
      } catch (err) {
        toast(`${tc('log.ttsFailed')}: ${(err as Error).message || err}`, 6000);
      }
    })),
  );

  let voicesLoaded = false;
  async function loadVoices() {
    if (voicesLoaded) return;
    voicesLoaded = true;
    const res = await vav.autocast.sayVoices();
    if (res.ok && res.value.length) {
      const lang = (v: SayVoice) => (/^ko/.test(v.locale) ? 0 : /^(en|ja)/.test(v.locale) ? 1 : 2);
      const list = [...res.value].sort((x, y) => lang(x) - lang(y) || x.name.localeCompare(y.name));
      sayVoice.setOptions(list.map((v) => ({ value: v.name, label: `${v.name.replace(/\s*\(.*\)$/, '')} · ${v.locale}` })), vo.sayVoice);
    }
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default');
      output.setOptions([{ value: '', label: tc('voice.default') }, ...devices.map((d) => ({ value: d.deviceId, label: d.label || d.deviceId.slice(0, 8) }))], vo.sinkId);
    } catch { /* no device list */ }
  }

  // -------------------------------------------------------------------------
  // Motion

  const mo = autocast.motion;
  pages.motion.append(
    toggle(tc('motion.idle'), mo.idle, (v) => { mo.idle = v; autocast.save(); }, tc('motion.idleHint')).el,
    // Shared with the desktop character (Animation panel).
    toggle(tc('motion.restPose'), mate.restPose !== false, (v) => { mate.restPose = v; mate.save(); }, tc('motion.restPoseHint')).el,
    toggle(tm('blink'), mate.blink !== false, (v) => { mate.blink = v; mate.save(); }).el,
    toggle(tc('motion.emotions'), mo.emotions, (v) => { mo.emotions = v; autocast.save(); }).el,
    toggle(tc('motion.gestures'), mo.gestures !== false, (v) => { mo.gestures = v; autocast.save(); }, tc('motion.gesturesHint')).el,
    slider({
      label: tc('motion.lipSync'), min: 0, max: 1.5, step: 0.05, value: mo.lipSync, format: (v) => `${Math.round(v * 100)}%`,
      onInput: (v) => { mo.lipSync = v; autocast.save(); },
    }).el,
    hint(tc('motion.hint')),
    hint(tc('motion.mateHint')),
    section(tc('gesture.title'), gestureButtons(app, c.life), hint(tc('gesture.hint'))),
    section(tc('frame.title'),
      h('div', { class: 'button-row' },
        button(tc('frame'), () => { if (!frameUpperBody(app)) toast(tc('needAvatar')); }),
        button(tc('frame.close'), () => { if (!frameUpperBody(app, 1.35)) toast(tc('needAvatar')); }),
        button(tc('frame.save'), () => app.saveLayout())),
      hint(tc('frame.hint'))),
  );

  shell.body.append(tabs.el, ...Object.values(pages));
  showTab();

  // -------------------------------------------------------------------------

  function refresh() {
    const b = c.brain;
    startBtn.textContent = b.running ? tc('stop') : tc('start');
    startBtn.classList.toggle('danger', b.running);
    pause.set(b.paused);
    const replyText = r.mode === 'llm' ? `${tc('reply.llm')} (${llm.model || '-'})` : r.mode === 'read' ? tc('reply.read') : tc('reply.off');
    status.textContent = [
      b.running ? (b.paused ? tc('status.paused') : tc('status.live')) : tc('status.off'),
      `${tc('tab.chzzk')}: ${tc(`chzzk.conn.${c.chzzk.connection}`)}`,
      `${tc('tab.reply')}: ${replyText}`,
      b.waiting ? tc('status.waiting', { n: b.waiting }) : '',
    ].filter(Boolean).join(' · ');
    llmBox.classList.toggle('disabled-box', r.mode !== 'llm');
    sayBox.classList.toggle('hidden', vo.engine !== 'say');
    httpBox.classList.toggle('hidden', vo.engine !== 'http');
    renderLog();
  }

  c.chzzk.onStatus = () => { refresh(); if (tab === 'chzzk') refreshChzzk(); };
  checkLlm();

  return {
    el: shell.el,
    refresh,
    onShow() { renderLog(true); if (tab === 'chzzk') refreshChzzk(); },
  };
}
