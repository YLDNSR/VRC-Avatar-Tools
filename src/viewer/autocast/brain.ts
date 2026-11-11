// What the avatar says: answers chat (local LLM or reading it aloud), talks on its own when chat is
// quiet, and lets the operator speak through it (streamer chat or the console) ahead of everything else.
// Each line starts with a fitting gesture: one the LLM or the operator asked for ([손인사], [끄덕], …),
// else one picked from greetings / thanks in the chat and the line's emotion.
import { autocast, type Emotion } from './settings';
import type { Speaker } from './speaker';
import type { GestureName, ActionPlayer } from '../mate/actions';
import type { LlmRequest, ViewerBridge } from '../../shared/bridge';
import { tc } from './strings';

const vav = (window as any).vav as ViewerBridge;

export type ChatRole = 'streamer' | 'manager' | 'viewer';

export interface ChatIn {
  nick: string;
  text: string;
  role: ChatRole;
  source: 'chzzk' | 'test';
}

export interface LogLine {
  kind: 'chat' | 'speech' | 'operator' | 'idle' | 'info' | 'error';
  who?: string;
  role?: ChatRole;
  text: string;
  at: number;
  /** chat that was not answered (filtered, paused, …) */
  skipped?: boolean;
}

type Message = LlmRequest['messages'][number];

interface Line { text: string; emotion: Emotion; action: GestureName | null }

const ACTION_TAGS: Record<string, GestureName> = {
  손인사: 'wave', 인사: 'wave', 손흔들기: 'wave', wave: 'wave',
  꾸벅: 'bow', 절: 'bow', 고개숙임: 'bow', bow: 'bow',
  끄덕: 'nod', 끄덕끄덕: 'nod', nod: 'nod',
  갸웃: 'tilt', 갸우뚱: 'tilt', tilt: 'tilt',
  생각: 'think', 고민: 'think', think: 'think',
  신남: 'happy', 들썩: 'happy',
  시무룩: 'sad',
  도리도리: 'shake', 절레절레: 'shake', shake: 'shake',
};

const GREET = /안녕|하이|ㅎㅇ|반가|방가|어서 ?오|하잉|헬로|hello|\bhi\b/i;
const BYE = /잘 ?가|잘 ?자|바이|빠이|ㅂㅂ|ㅃㅃ|굿 ?나잇|좋은 ?밤|다음에 ?(봐|만나)|수고하셨|\bbye\b/i;
const THANKS = /고마|감사|ㄱㅅ|땡큐|미안|죄송|thank|sorry/i;
const EMOTION_GESTURE: Partial<Record<Emotion, GestureName>> = { happy: 'happy', surprised: 'surprised', sad: 'sad', angry: 'shake' };

const EMOTION_TAGS: Record<string, Emotion> = {
  기쁨: 'happy', 행복: 'happy', happy: 'happy', joy: 'happy',
  슬픔: 'sad', sad: 'sad',
  화남: 'angry', 분노: 'angry', angry: 'angry',
  놀람: 'surprised', surprised: 'surprised',
  평온: 'relaxed', relaxed: 'relaxed', 차분: 'relaxed',
  보통: 'neutral', neutral: 'neutral',
};

/** CHZZK emoticon placeholders ({:d_47:}) and stray whitespace removed. */
export function cleanChat(s: string) {
  return s.replace(/\{:[^:{}]+:\}/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * Emotion and gesture tags taken out of a line: [기쁨], [손인사], … With onlyKnown, other bracketed text
 * stays (operator lines); otherwise any short bracketed aside goes (LLM lines).
 */
export function takeTags(raw: string, onlyKnown = false): Line {
  let emotion: Emotion = 'neutral';
  let action: GestureName | null = null;
  const text = raw.replace(/[[(（【]\s*([^\]）)】]{1,12}?)\s*[\]）)】]/g, (m, tag: string) => {
    const key = tag.trim().toLowerCase().replace(/\s+/g, '');
    const e = EMOTION_TAGS[key];
    const g = ACTION_TAGS[key];
    if (e && emotion === 'neutral') emotion = e;
    if (g && !action) action = g;
    return e || g || !onlyKnown ? ' ' : m;
  });
  return { text: text.replace(/\s+/g, ' ').trim(), emotion, action };
}

/** The LLM answer as speakable text: tags, emoji and markup removed, cut at a sentence end. */
export function parseReply(raw: string, maxChars: number): Line {
  const tagged = takeTags(raw.replace(/<think>[\s\S]*?<\/think>/gi, ' '));
  const { emotion, action } = tagged;
  let s = tagged.text;
  s = s.replace(/https?:\/\/\S+/g, ' ')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[*_#>`|~^=<{}\[\]]/g, ' ')
    .replace(/^\s*[^\s:]{1,20}\s*:\s*/, '') // "이름: …" prefix copied from the chat format
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > maxChars) {
    const cut = s.slice(0, maxChars);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '), cut.lastIndexOf('요 '), cut.lastIndexOf('다 '));
    s = end > maxChars * 0.4 ? cut.slice(0, end + 1) : cut;
  }
  return { text: s.trim(), emotion, action };
}

function words(list: string, sep: RegExp) {
  return list.split(sep).map((w) => w.trim().toLowerCase()).filter(Boolean);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Brain {
  running = false;
  /** Operator pause: chat is still shown and read by nobody; operator speech still works */
  paused = false;
  /** Waiting for the LLM */
  thinking = false;
  /** Emotion of the line being spoken (for the face) */
  emotion: Emotion = 'neutral';
  log: LogLine[] = [];
  onChange?: () => void;

  private queue: (ChatIn & { line: LogLine })[] = [];
  private operatorQueue: string[] = [];
  private history: Message[] = [];
  private busy = false;
  private llmId = '';
  private lastActivity = performance.now();
  private nextIdle = 0;
  private lastIdleLine = '';
  private lastSpokeAt = 0;
  private idleTimer = 0;

  constructor(private speaker: Speaker, private gestures: ActionPlayer, private avatarName: () => string) {}

  get waiting() {
    return this.queue.length;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.paused = false;
    this.lastActivity = performance.now();
    this.planIdle();
    clearInterval(this.idleTimer);
    this.idleTimer = window.setInterval(() => this.pump(), 1000);
    this.push({ kind: 'info', text: tc('log.started') });
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.idleTimer);
    this.dropQueue();
    this.operatorQueue = [];
    this.cancelLlm();
    this.speaker.stop();
    this.push({ kind: 'info', text: tc('log.stopped') });
  }

  setPaused(v: boolean) {
    this.paused = v;
    if (v) {
      this.dropQueue();
      this.cancelLlm();
    }
    this.lastActivity = performance.now();
    this.planIdle();
    this.changed();
  }

  /** Stops the current line (the next one in line follows). */
  skip() {
    this.cancelLlm();
    this.speaker.stop();
  }

  clearHistory() {
    this.history = [];
  }

  receive(c: ChatIn) {
    const text = cleanChat(c.text);
    const line = this.push({ kind: 'chat', who: c.nick, role: c.role, text: text || c.text });
    if (!this.running) { line.skipped = true; return; }
    const op = autocast.operator;
    if (c.role === 'streamer' && op.streamerSpeaks && (!op.prefix || text.startsWith(op.prefix))) {
      this.say(op.prefix ? text.slice(op.prefix.length) : text);
      return;
    }
    this.lastActivity = performance.now();
    this.planIdle();
    const lower = text.toLowerCase();
    const skip = !text
      || words(autocast.reply.ignorePrefixes, /\s+/).some((p) => lower.startsWith(p))
      || words(autocast.reply.banned, /[,\n]/).some((w) => lower.includes(w))
      || autocast.reply.mode === 'off' || this.paused;
    if (skip) { line.skipped = true; this.changed(); return; }
    this.queue.push({ ...c, text, line });
    while (this.queue.length > Math.max(1, autocast.reply.maxQueue)) this.queue.shift()!.line.skipped = true;
    this.changed();
    this.pump();
  }

  /** Chats in waiting will not be answered (shown faded in the log). */
  private dropQueue() {
    for (const q of this.queue) q.line.skipped = true;
    this.queue = [];
    this.changed();
  }

  /** Operator speech: the avatar says exactly this, ahead of (and instead of) answers in waiting. */
  say(text: string) {
    const s = text.trim();
    if (!s) return;
    if (autocast.operator.clearQueue) this.dropQueue();
    this.cancelLlm();
    this.speaker.stop();
    this.operatorQueue.push(s);
    this.pump();
  }

  private planIdle() {
    const { minSec, maxSec } = autocast.idle;
    const lo = Math.max(10, Math.min(minSec, maxSec));
    const hi = Math.max(lo, maxSec);
    this.nextIdle = this.lastActivity + (lo + Math.random() * (hi - lo)) * 1000;
  }

  private async pump() {
    if (this.busy || !this.running) return;
    this.busy = true;
    try {
      while (this.running) {
        const op = this.operatorQueue.shift();
        if (op !== undefined) {
          // [손인사], [기쁨], … in operator text: the gesture / face, not spoken. A tag alone only moves.
          const line = takeTags(op, true);
          if (!line.text) { if (line.action && this.gesturesOn()) this.gestures.play(line.action); continue; }
          this.remember('assistant', line.text);
          await this.speakLine(line, 'operator', '');
          continue;
        }
        const chat = this.queue.shift();
        if (chat) {
          await this.gap();
          if (this.operatorQueue.length || !this.running) { chat.line.skipped = true; continue; }
          const line = await this.answer(chat);
          if (line && !this.operatorQueue.length && this.running) await this.speakLine(line, 'speech', chat.text);
          else { chat.line.skipped = true; this.changed(); }
          continue;
        }
        if (autocast.idle.enabled && !this.paused && performance.now() >= this.nextIdle) {
          const line = await this.idleLine();
          if (line && !this.operatorQueue.length && !this.queue.length && this.running) await this.speakLine(line, 'idle', '');
          this.lastActivity = performance.now();
          this.planIdle();
          continue;
        }
        break;
      }
    } finally {
      this.busy = false;
    }
  }

  /** A short pause between two lines, cut short by operator speech. */
  private async gap() {
    const until = this.lastSpokeAt + autocast.reply.gapSec * 1000;
    while (this.running && !this.operatorQueue.length && performance.now() < until) await sleep(100);
  }

  private async speakLine(line: Line, kind: 'speech' | 'operator' | 'idle', heard: string) {
    const { text, emotion } = line;
    const banned = words(autocast.reply.banned, /[,\n]/);
    if (kind !== 'operator' && banned.some((w) => text.toLowerCase().includes(w))) {
      this.push({ kind: 'error', text: tc('log.bannedReply') });
      return;
    }
    this.push({ kind, text, at: Date.now() });
    this.emotion = emotion;
    const gesture = this.pickGesture(line, kind, heard);
    try {
      // The gesture starts with the voice (synthesis takes a moment).
      await this.speaker.speak(text, () => { if (gesture) this.gestures.play(gesture); });
    } catch (err) {
      this.push({ kind: 'error', text: `${tc('log.ttsFailed')}: ${(err as Error).message || err}` });
      await sleep(1500);
    } finally {
      this.emotion = 'neutral';
      this.lastSpokeAt = performance.now();
      this.lastActivity = performance.now();
      this.planIdle();
      this.changed();
    }
  }

  private gesturesOn() {
    return autocast.motion.gestures !== false;
  }

  /** The gesture for a line: asked for by the operator (always) or the LLM, else from the words and emotion. */
  private pickGesture(line: Line, kind: 'speech' | 'operator' | 'idle', heard: string): GestureName | null {
    if (!this.gesturesOn()) return null;
    const g = this.gestures;
    if (line.action && (kind === 'operator' || g.ready(line.action))) return line.action;
    const said = `${heard} ${line.text}`;
    const options: GestureName[] = [];
    if (GREET.test(said) || BYE.test(said)) options.push('wave');
    if (THANKS.test(said)) options.push('bow');
    const byEmotion = EMOTION_GESTURE[line.emotion];
    if (byEmotion) options.push(byEmotion);
    if (kind === 'idle') { if (Math.random() < 0.4) options.push('tilt'); }
    else if (Math.random() < 0.5) options.push('nod');
    return options.find((o) => g.ready(o)) ?? null;
  }

  private async answer(chat: ChatIn): Promise<Line | null> {
    const maxChars = autocast.reply.maxChars;
    if (autocast.reply.mode === 'read') return { text: this.readAloud(chat), emotion: 'neutral', action: null };
    const user = `${chat.nick || tc('test.viewer')}: ${chat.text}`;
    const reply = await this.llm([...this.history, { role: 'user', content: user }]);
    if (reply === null) return null;
    if (reply instanceof Error) {
      // No LLM (not installed / not running): read the chat instead of staying silent.
      this.push({ kind: 'error', text: `${tc('log.llmFailed')}: ${reply.message}` });
      return { text: this.readAloud(chat), emotion: 'neutral', action: null };
    }
    const parsed = parseReply(reply, maxChars);
    if (!parsed.text) return null;
    this.remember('user', user);
    this.remember('assistant', parsed.text);
    return parsed;
  }

  private readAloud(chat: ChatIn) {
    const msg = chat.text.slice(0, 120);
    return (autocast.reply.readFormat || '{nick}, {msg}').replace(/\{nick\}/g, chat.nick || '').replace(/\{msg\}/g, msg).trim();
  }

  private async idleLine(): Promise<Line | null> {
    if (autocast.idle.useLlm && autocast.reply.mode === 'llm') {
      const prompt = tc('prompt.idle', { topics: autocast.idle.topics || '-' });
      const reply = await this.llm([...this.history, { role: 'user', content: prompt }]);
      if (reply === null) return null;
      if (!(reply instanceof Error)) {
        const parsed = parseReply(reply, autocast.reply.maxChars);
        if (parsed.text) {
          this.remember('assistant', parsed.text);
          return parsed;
        }
      }
    }
    const lines = autocast.idle.lines.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return null;
    const pool = lines.length > 1 ? lines.filter((l) => l !== this.lastIdleLine) : lines;
    const text = pool[Math.floor(Math.random() * pool.length)];
    this.lastIdleLine = text;
    return takeTags(text, true);
  }

  /** The LLM's answer; null when cancelled, an Error when the request failed. */
  private async llm(messages: Message[]): Promise<string | Error | null> {
    const cfg = autocast.llm;
    const id = crypto.randomUUID();
    this.llmId = id;
    this.thinking = true;
    this.changed();
    try {
      const r = await vav.autocast.llm({
        id, api: cfg.api, url: cfg.url, model: cfg.model, temperature: cfg.temperature, maxTokens: 220,
        messages: [{ role: 'system', content: this.systemPrompt() }, ...messages],
      });
      if (this.llmId !== id) return null;
      if (!r.ok) return r.error === 'cancelled' ? null : new Error(r.error);
      return r.value;
    } finally {
      if (this.llmId === id) {
        this.llmId = '';
        this.thinking = false;
        this.changed();
      }
    }
  }

  private cancelLlm() {
    if (this.llmId) vav.autocast.llmCancel(this.llmId);
    this.llmId = '';
    this.thinking = false;
  }

  systemPrompt() {
    return tc('prompt.system', {
      name: autocast.name.trim() || this.avatarName() || tc('prompt.defaultName'),
      persona: autocast.persona.trim() || '-',
      max: autocast.reply.maxChars,
    });
  }

  private remember(role: 'user' | 'assistant', content: string) {
    this.history.push({ role, content });
    const keep = Math.max(0, autocast.llm.history) * 2;
    if (this.history.length > keep) this.history.splice(0, this.history.length - keep);
  }

  private push(l: Omit<LogLine, 'at'> & { at?: number }): LogLine {
    const entry: LogLine = { at: Date.now(), ...l };
    this.log.push(entry);
    if (this.log.length > 200) this.log.splice(0, this.log.length - 200);
    this.changed();
    return entry;
  }

  private changed() {
    this.onChange?.();
  }
}
