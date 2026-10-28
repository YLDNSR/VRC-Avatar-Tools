// ARKit-style blendshapes → calibrated face values (blink tuning, gaze, VRM vowels).
import * as THREE from 'three';
import { ARKIT_NAMES } from '../shared/face';

export interface EyeParams { amount: number; vertical: number; close: number; open: number }

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function swapLeftRight(shapes: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(shapes)) {
    const swapped = k.endsWith('Left') ? k.slice(0, -4) + 'Right' : k.endsWith('Right') ? k.slice(0, -5) + 'Left' : k;
    out[swapped] = v;
  }
  return out;
}

export class FaceMapper {
  /** neutral values recorded during calibration */
  baseline: Record<string, number> | null = null;
  private last: Record<string, number> = {};

  calibrate() {
    this.baseline = { ...this.last };
  }

  /**
   * Applies calibration + eye tuning. `raw` uses ARKit names from the person's point of view.
   * Returns calibrated ARKit weights and a gaze vector (x: avatar-left positive, y: up positive).
   */
  process(raw: Record<string, number>, eye: EyeParams) {
    this.last = raw;
    const b = this.baseline || {};
    const out: Record<string, number> = {};
    for (const name of ARKIT_NAMES) {
      let v = raw[name] ?? 0;
      const base = b[name] ?? 0;
      // Remove the neutral offset for shapes that are often non-zero at rest.
      if (/^(brow|eyeSquint|eyeWide|mouthPress|mouthClose|mouthShrug|mouthRoll|cheekSquint|noseSneer|mouthDimple|mouthStretch|mouthFrown)/.test(name) && base < 0.9) {
        v = clamp01((v - base) / (1 - base));
      }
      out[name] = v;
    }
    // Blink: rescale from the calibrated open level, then apply "close/open ease".
    for (const side of ['Left', 'Right']) {
      const k = `eyeBlink${side}`;
      const base = Math.min(0.6, b[k] ?? 0.1);
      const v = clamp01(((raw[k] ?? 0) - base) / (1 - base));
      const lo = 0.1 + 0.35 * eye.open;      // below this: fully open
      const hi = 0.95 - 0.45 * eye.close;    // above this: fully closed
      out[k] = THREE.MathUtils.smoothstep(v, Math.min(lo, hi - 0.05), hi);
    }
    // Gaze from eyeLook shapes (relative to calibration)
    const g = (n: string) => (raw[n] ?? 0) - (b[n] ?? 0);
    const x = ((g('eyeLookOutLeft') - g('eyeLookInLeft')) + (g('eyeLookInRight') - g('eyeLookOutRight'))) / 2;
    const y = ((g('eyeLookUpLeft') + g('eyeLookUpRight')) - (g('eyeLookDownLeft') + g('eyeLookDownRight'))) / 2;
    const gaze = {
      x: THREE.MathUtils.clamp(x * 1.6 * eye.amount, -1, 1),
      y: THREE.MathUtils.clamp(y * 1.6 * eye.amount + eye.vertical, -1, 1),
    };
    return { shapes: out, gaze };
  }
}

/** VRM 0.x standard vowel weights derived from mouth shapes. */
export function vowelsFromArkit(a: Record<string, number>) {
  const jaw = a.jawOpen || 0;
  const funnel = a.mouthFunnel || 0;
  const pucker = a.mouthPucker || 0;
  const smile = ((a.mouthSmileLeft || 0) + (a.mouthSmileRight || 0)) / 2;
  const stretch = ((a.mouthStretchLeft || 0) + (a.mouthStretchRight || 0)) / 2;
  const lowerDown = ((a.mouthLowerDownLeft || 0) + (a.mouthLowerDownRight || 0)) / 2;
  const open = clamp01(jaw * 1.8);
  const O = clamp01(funnel * 1.6) * clamp01(open * 1.5);
  const U = clamp01(pucker * 1.4) * (1 - clamp01(open * 1.2));
  const A = open * (1 - clamp01(funnel * 1.5)) * (1 - clamp01(pucker));
  const E = clamp01((stretch + lowerDown) * 1.5) * clamp01(open * 2.5) * (1 - clamp01(funnel * 2)) * 0.7;
  const Ival = clamp01((smile * 0.5 + stretch) * 1.5) * (1 - open) * (1 - clamp01(pucker * 2));
  const out = { A, I: Ival, U, E, O };
  // keep the dominant vowel clear
  const max = Math.max(A, Ival, U, E, O);
  if (max > 0.05) for (const k of Object.keys(out) as (keyof typeof out)[]) if (out[k] < max * 0.5) out[k] *= 0.4;
  return out;
}

/** Eye bone rotation (avatar space) from a gaze vector. */
export function eyeRotation(gaze: { x: number; y: number }) {
  const yaw = gaze.x * THREE.MathUtils.degToRad(18);
  const pitch = gaze.y * THREE.MathUtils.degToRad(14);
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(-pitch, yaw, 0, 'YXZ'));
}
