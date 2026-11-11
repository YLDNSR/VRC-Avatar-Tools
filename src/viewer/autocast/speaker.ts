// Speech output: synthesizes text (a macOS voice or a local TTS server), plays it and measures the
// mouth shape (volume + a simple formant vowel estimate) for lip sync.
import { autocast } from './settings';
import type { ViewerBridge } from '../../shared/bridge';

const vav = (window as any).vav as ViewerBridge;

const VOWELS: Record<string, [number, number]> = {
  // [F1, F2] in Hz (average adult)
  A: [800, 1250],
  I: [320, 2400],
  U: [360, 1300],
  E: [520, 1950],
  O: [520, 900],
};

export type Vowels = { A: number; I: number; U: number; E: number; O: number };

export class Speaker {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private source: AudioBufferSourceNode | null = null;
  private freq: Float32Array<ArrayBuffer> = new Float32Array(0);
  private time: Float32Array<ArrayBuffer> = new Float32Array(0);
  /** Bumped by stop(): speech started before it does not play any more. */
  private token = 0;
  level = 0;
  vowels: Vowels = { A: 0, I: 0, U: 0, E: 0, O: 0 };
  speaking = false;

  private ensure() {
    if (this.ctx) return this.ctx;
    const ctx = new AudioContext();
    this.gain = ctx.createGain();
    this.gain.connect(ctx.destination);
    // The analyser hears the voice before the volume, so a quiet output still moves the mouth.
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.45;
    this.freq = new Float32Array(this.analyser.frequencyBinCount);
    this.time = new Float32Array(this.analyser.fftSize);
    this.ctx = ctx;
    this.applyOutput();
    return ctx;
  }

  /** Call from a click: audio may only start after a user gesture. */
  unlock() {
    this.ensure().resume().catch(() => {});
  }

  /** Output device (e.g. a virtual device that OBS records); '' = system default. */
  async applyOutput() {
    const ctx = this.ctx as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (!ctx?.setSinkId) return;
    try {
      await ctx.setSinkId(autocast.voice.sinkId || '');
    } catch (err) {
      console.warn('[autocast] output device', err);
    }
  }

  async synth(text: string): Promise<ArrayBuffer> {
    const v = autocast.voice;
    const r = v.engine === 'http'
      ? await vav.autocast.ttsHttp(v.httpUrl, {
        input: text,
        ...(v.httpModel ? { model: v.httpModel } : {}),
        ...(v.httpVoice ? { voice: v.httpVoice } : {}),
        response_format: 'wav',
      })
      : await vav.autocast.say(text, v.sayVoice, v.rate);
    if (!r.ok) throw new Error(r.error);
    const u8 = r.value;
    return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
  }

  /** Speaks the text; false when it was stopped before it finished. Synthesis errors are thrown. */
  async speak(text: string, onStart?: () => void): Promise<boolean> {
    const token = this.token;
    const ctx = this.ensure();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    const data = await this.synth(text);
    if (token !== this.token) return false;
    const buffer = await ctx.decodeAudioData(data);
    if (token !== this.token) return false;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.gain!);
    src.connect(this.analyser!);
    this.gain!.gain.value = autocast.voice.volume;
    this.source = src;
    this.speaking = true;
    await new Promise<void>((resolve) => {
      src.onended = () => resolve();
      src.start();
      onStart?.();
    });
    if (this.source === src) {
      this.source = null;
      this.speaking = false;
    }
    return token === this.token;
  }

  stop() {
    this.token++;
    const src = this.source;
    this.source = null;
    this.speaking = false;
    try { src?.stop(); } catch { /* not started */ }
  }

  update() {
    const an = this.analyser;
    if (!an || !this.ctx || !this.speaking) {
      this.level *= 0.7;
      for (const k of Object.keys(this.vowels) as (keyof Vowels)[]) this.vowels[k] *= 0.6;
      return;
    }
    an.getFloatTimeDomainData(this.time);
    let sum = 0;
    for (let i = 0; i < this.time.length; i++) sum += this.time[i] * this.time[i];
    const rms = Math.sqrt(sum / this.time.length);
    const db = 20 * Math.log10(rms + 1e-9);
    const target = Math.min(1, Math.max(0, (db + 50) / 30)); // -50 dB .. -20 dB
    this.level += (target - this.level) * (target > this.level ? 0.6 : 0.3);

    an.getFloatFrequencyData(this.freq);
    const binHz = this.ctx.sampleRate / an.fftSize;
    const peak = (lo: number, hi: number) => {
      let best = -Infinity, at = lo;
      for (let f = lo; f <= hi; f += binHz) {
        const i = Math.round(f / binHz);
        const v = (this.freq[i - 1] + this.freq[i] * 2 + this.freq[i + 1]) / 4;
        if (v > best) { best = v; at = f; }
      }
      return at;
    };
    const f1 = peak(200, 1000);
    const f2 = peak(Math.max(800, f1 + 300), 3000);
    const w: Record<string, number> = {};
    let total = 0;
    for (const [k, [v1, v2]] of Object.entries(VOWELS)) {
      const d = Math.hypot((f1 - v1) / 250, (f2 - v2) / 600);
      w[k] = Math.exp(-d * d);
      total += w[k];
    }
    for (const k of Object.keys(this.vowels) as (keyof Vowels)[]) {
      const t = total > 0 ? (w[k] / total) * this.level * 1.4 : 0;
      this.vowels[k] += (Math.min(1, t) - this.vowels[k]) * 0.5;
    }
  }
}
