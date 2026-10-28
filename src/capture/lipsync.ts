// Microphone lip sync: volume + simple formant-based vowel estimation (A I U E O).

const VOWELS: Record<string, [number, number]> = {
  // [F1, F2] in Hz (average adult, Japanese vowels)
  A: [800, 1250],
  I: [320, 2400],
  U: [360, 1300],
  E: [520, 1950],
  O: [520, 900],
};

export class LipSync {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private freq: Float32Array<ArrayBuffer> = new Float32Array(0);
  private time: Float32Array<ArrayBuffer> = new Float32Array(0);
  level = 0;
  vowels = { A: 0, I: 0, U: 0, E: 0, O: 0 };
  running = false;

  async start(deviceId: string) {
    await this.stop();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: false, noiseSuppression: true, autoGainControl: true },
    });
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.5;
    src.connect(this.analyser);
    this.freq = new Float32Array(this.analyser.frequencyBinCount);
    this.time = new Float32Array(this.analyser.fftSize);
    this.running = true;
  }

  async stop() {
    this.running = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.ctx) await this.ctx.close().catch(() => {});
    this.ctx = null;
    this.analyser = null;
    this.level = 0;
  }

  update() {
    const an = this.analyser;
    if (!an || !this.ctx) return;
    an.getFloatTimeDomainData(this.time);
    let sum = 0;
    for (let i = 0; i < this.time.length; i++) sum += this.time[i] * this.time[i];
    const rms = Math.sqrt(sum / this.time.length);
    const db = 20 * Math.log10(rms + 1e-9);
    const target = Math.min(1, Math.max(0, (db + 52) / 32)); // -52 dB .. -20 dB
    this.level += (target - this.level) * (target > this.level ? 0.6 : 0.25);

    an.getFloatFrequencyData(this.freq);
    const binHz = this.ctx.sampleRate / an.fftSize;
    // Two strongest peaks in F1 (200-1000 Hz) and F2 (800-3000 Hz) bands
    const peak = (lo: number, hi: number) => {
      let best = -Infinity, at = lo;
      for (let f = lo; f <= hi; f += binHz) {
        const i = Math.round(f / binHz);
        // smooth over neighbours
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
    const open = this.level;
    for (const k of Object.keys(this.vowels) as (keyof typeof this.vowels)[]) {
      const target = total > 0 ? (w[k] / total) * open * 1.4 : 0;
      this.vowels[k] += (Math.min(1, target) - this.vowels[k]) * 0.45;
    }
  }
}
