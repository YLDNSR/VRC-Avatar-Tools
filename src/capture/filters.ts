// One Euro filter (Casiez et al.) for jitter reduction with low lag on fast motion.

class LowPass {
  y = 0;
  s = false;
  filter(x: number, a: number) {
    if (!this.s) { this.s = true; this.y = x; return x; }
    this.y = a * x + (1 - a) * this.y;
    return this.y;
  }
}

function alpha(cutoff: number, dt: number) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

export class OneEuro {
  private x = new LowPass();
  private dx = new LowPass();
  private lastX = 0;
  private has = false;
  constructor(public minCutoff = 1.0, public beta = 0.01, public dCutoff = 1.0) {}

  filter(value: number, dt: number) {
    if (dt <= 0) dt = 1 / 60;
    const d = this.has ? (value - this.lastX) / dt : 0;
    this.lastX = value;
    this.has = true;
    const edx = this.dx.filter(d, alpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    return this.x.filter(value, alpha(cutoff, dt));
  }

  reset() {
    this.x = new LowPass();
    this.dx = new LowPass();
    this.has = false;
  }
}

/** Filters an array of 3D points (flattened xyz). */
export class PointsFilter {
  private filters: OneEuro[] = [];
  minCutoff = 1;
  beta = 0.01;

  /** stability 0..1 (higher = steadier), responsiveness 0..1 (higher = quicker on fast motion) */
  configure(stability: number, responsiveness: number) {
    this.minCutoff = 4.0 * Math.pow(0.04, stability); // 4 Hz .. 0.16 Hz
    this.beta = 0.002 + responsiveness * responsiveness * 2.0;
    for (const f of this.filters) { f.minCutoff = this.minCutoff; f.beta = this.beta; }
  }

  apply(values: number[], dt: number): number[] {
    while (this.filters.length < values.length) this.filters.push(new OneEuro(this.minCutoff, this.beta));
    return values.map((v, i) => this.filters[i].filter(v, dt));
  }

  reset() {
    for (const f of this.filters) f.reset();
  }
}
