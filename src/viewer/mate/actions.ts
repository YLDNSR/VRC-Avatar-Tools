// Short motions the avatar plays now and then or on request: reaction gestures that go with what it says
// during the broadcast (wave, bow, nod, …), small things it does on its own as a desktop character
// (stretching, looking around, yawning, …) and reactions when clicked (a pat on the head, a poke). Each one
// is a timeline of bone rotations (bones.ts), a lower body (body.ts: the weight from leg to leg, knees,
// heels, steps), a face (faces.ts) and a direction to look in. They are acted with the whole body, as
// someone in full-body tracking would: the weight moves before a foot does, the hips answer what the arms
// and chest do, and every motion eases back into standing (the arms and hands a moment after the body).
import type { VRMHumanBoneName } from '@pixiv/three-vrm';
import { fingerBones } from '../../shared/bones';
import { add, pose, part, flip, mirrored, type BoneMove, type Frame } from './bones';
import type { BodyKeys } from './body';

export type GestureName = 'wave' | 'bow' | 'nod' | 'tilt' | 'think' | 'happy' | 'surprised' | 'sad' | 'shake';
export type IdleActionName = 'stretch' | 'look' | 'yawn' | 'hair' | 'sway' | 'doze' | 'neck' | 'hands';
/** Reactions to being clicked (interact.ts) */
export type ReactionName = 'pat' | 'poke' | 'handL' | 'handR' | 'leg' | 'annoyed';
export type ActionName = GestureName | IdleActionName | ReactionName;

/** Reaction gestures (the broadcast picks them for its lines) */
export const GESTURES: GestureName[] = ['wave', 'bow', 'nod', 'tilt', 'think', 'happy', 'surprised', 'sad', 'shake'];
/** Things the avatar does on its own */
export const IDLE_ACTIONS: IdleActionName[] = ['stretch', 'look', 'yawn', 'hair', 'sway', 'doze', 'neck', 'hands'];

/** Where to look: [yaw (+ = the avatar's left), pitch (+ = down)] in degrees, and how much (default 1). */
type Gaze = [number, number] | [number, number, number];

interface Def {
  fadeIn: number;
  fadeOut: number;
  /** seconds (a held action lasts until released) */
  length: number;
  /** arms it moves: left out while a motion or avatar animation poses them; hands held together let go */
  arms?: 'right' | 'left' | 'both';
  /** how much the arms are used at time t (0..1), when they join in only for part of it */
  armsAt?(t: number): number;
  /** seconds before it is chosen again automatically */
  cooldown: number;
  /** chosen now and then on its own (how likely, relative to the others) */
  idle?: number;
  /** may also be chosen on its own while the broadcast runs */
  onAir?: boolean;
  frame(t: number): Frame;
  /** the lower body: hips, weight, knees, heels, feet */
  body?(t: number): BodyKeys;
  /** faces (faces.ts names, or VRM expression names) 0..1 */
  face?(t: number): Record<string, number>;
  /** where the eyes and head look meanwhile */
  gaze?(t: number): Gaze;
}

// ---- Timing helpers ------------------------------------------------------------------------------------

const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
/**
 * Eased in and out, passing the target by about 9 % and settling back: starts from rest (no jerk), so
 * quick moves read as springy rather than snapped.
 */
const back = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x) + 7 * x * x * (1 - x) * (1 - x));
const sin = (t: number, hz: number) => Math.sin(t * Math.PI * 2 * hz);

function keys(t: number, ease: (x: number) => number, k: [number, number][]) {
  if (t <= k[0][0]) return k[0][1];
  for (let i = 1; i < k.length; i++) {
    const [t1, v1] = k[i];
    if (t < t1) {
      const [t0, v0] = k[i - 1];
      return v0 + (v1 - v0) * ease((t - t0) / (t1 - t0));
    }
  }
  return k[k.length - 1][1];
}
/** Eased value between keyframes [seconds, value], held before the first and after the last one. */
const K = (t: number, ...k: [number, number][]) => keys(t, smooth, k);
/** Like K, but each change overshoots a little and settles: snappy. */
const B = (t: number, ...k: [number, number][]) => keys(t, back, k);
/** 0 → 1 → 0 between t0 and t1. */
const bump = (t: number, t0: number, t1: number) => (t <= t0 || t >= t1 ? 0 : Math.sin((Math.PI * (t - t0)) / (t1 - t0)) ** 2);
/** Up to 1 in `up` seconds from t0, back to 0 in `down` seconds: a nod, a start. */
const pulse = (t: number, t0: number, up: number, down: number) =>
  t <= t0 ? 0 : t < t0 + up ? smooth((t - t0) / up) : 1 - smooth((t - t0 - up) / down);
/** A foot lifted on the way between t0 and t1 (a step), metres. */
const stepUp = (t: number, t0: number, t1: number, h = 0.03) => h * bump(t, t0, t1);

// ---- Hands ---------------------------------------------------------------------------------------------

/** How far each finger curls, thumb … little (0 straight, 1 a fist). */
type Curl = [number, number, number, number, number];
const OPEN: Curl = [0.05, 0, 0.03, 0.06, 0.1];
const SOFT: Curl = [0.35, 0.3, 0.35, 0.42, 0.48];
const FIST: Curl = [0.85, 1, 1, 1, 1];
const POINT: Curl = [0.75, 0, 1, 1, 1];
const JOINT = [70, 90, 55];
const THUMB = [20, 35, 35];
const SPREAD = [0, 1, 0.25, -0.45, -1];

/** Finger pose of one hand; spread: degrees between the fingers. */
function fingers(side: 'right' | 'left', curl: Curl, spread = 0): Frame {
  const s = side === 'right' ? 1 : -1;
  const f: Frame = {};
  fingerBones(side).forEach((chain, i) => chain.forEach((bone, j) => {
    f[bone as VRMHumanBoneName] = i === 0 ? pose(['x', THUMB[j] * curl[0]])
      : j === 0 && spread ? pose(['y', s * SPREAD[i] * spread], ['z', s * JOINT[j] * curl[i]])
      : pose(['z', s * JOINT[j] * curl[i]]);
  }));
  return f;
}
const bothHands = (curl: Curl, spread = 0): Frame => ({ ...fingers('right', curl, spread), ...fingers('left', curl, spread) });

// ---- Arm poses (right arm; mirrored() gives both) --------------------------------------------------------
// Worked out so the hands land where they should on a small avatar; on others they stay close.

/** Hands up in front of the chest (startled) */
const CHEST: Frame = { rightUpperArm: pose(['x', 15], ['z', 75], ['y', -15]), rightLowerArm: pose(['y', 128]) };
/** Hands pulled to the chest, elbows out (poked) */
const CLUTCH: Frame = { rightUpperArm: pose(['x', 45], ['z', 65], ['y', -15]), rightLowerArm: pose(['y', 128]) };
/** Hands together low in front */
const LOW: Frame = { rightUpperArm: pose(['x', 15], ['z', 80], ['y', 39]), rightLowerArm: pose(['y', 40]) };
/** Hands pressing down the front of the skirt */
const SKIRT: Frame = { rightUpperArm: pose(['x', 30], ['z', 70], ['y', 33]), rightLowerArm: pose(['y', 40]) };
/** Hands on the cheeks */
const CHEEKS: Frame = { rightUpperArm: pose(['x', -45], ['z', 60], ['y', 57]), rightLowerArm: pose(['y', 144]) };
/** Hands behind the back */
const BEHIND: Frame = { rightUpperArm: pose(['x', 130], ['z', 70], ['y', -16]), rightLowerArm: pose(['y', 80]) };
/** Arms stiff at the sides, a little back (pouting) */
const STIFF: Frame = { rightUpperArm: pose(['z', 80], ['y', -14]), rightLowerArm: pose(['y', 8]) };

/** Both arms in a pose, at part strength. */
function arms(f: Frame, w = 1): Frame {
  const out = mirrored(f);
  if (w < 1) for (const k of Object.keys(out) as VRMHumanBoneName[]) out[k] = part(out[k]!, w);
  return out;
}

/** The right arm between two poses: [x, z, y] of the upper arm and y of the lower arm, blended by k. */
function armBetween(a: [number, number, number, number], b: [number, number, number, number], k: number): Frame {
  const m = (i: number) => a[i] + (b[i] - a[i]) * k;
  return { rightUpperArm: pose(['x', m(0)], ['z', m(1)], ['y', m(2)]), rightLowerArm: pose(['y', m(3)]) };
}

/** Reaction to a hand being touched: it comes up a little, the avatar leans to look at it, then smiles at the viewer. */
function touchedHand(side: 'right' | 'left'): Def {
  const s = side === 'right' ? 1 : -1;
  const sided = (m: BoneMove) => (side === 'right' ? m : flip(m));
  const lift = (t: number) => B(t, [0.05, 0], [0.4, 1], [1.7, 1], [2.3, 0]);
  return {
    fadeIn: 0.3, fadeOut: 0.9, length: 2.8, arms: side, cooldown: 0,
    frame: (t) => {
      const l = lift(t);
      return {
        [`${side}UpperArm`]: sided(pose(['z', 72 - 10 * l], ['y', 8 + 16 * l])),
        [`${side}LowerArm`]: sided(pose(['y', 16 + 44 * l])),
        ...fingers(side, [0.15, 0.05, 0.1, 0.15, 0.2], 10 * l),
        head: add(['x', 10 * K(t, [0, 1], [1.2, 1], [1.7, 0.3])], ['y', -10 * s], ['z', -5 * s]),
        chest: add(['y', -4 * s], ['z', 2 * s * l]),
      };
    },
    body: (t) => ({ weight: 0.4 * s * lift(t), bob: 3 * pulse(t, 0.02, 0.15, 0.45) }),
    face: (t) => ({ smallO: 0.45 * K(t, [0.05, 0], [0.3, 1], [1.0, 1], [1.3, 0]), happy: 0.7 * K(t, [1.05, 0], [1.45, 1]), blush: 0.55 }),
    gaze: (t) => [-22 * s, 28, K(t, [1.1, 1], [1.55, 0])],
  };
}

const DEFS: Record<ActionName, Def> = {
  // ---- Reaction gestures ---------------------------------------------------------------------------
  // The weight goes onto the left leg first, then the right hand comes up beside the face, the forearm
  // swinging and the hand flapping a moment behind it; the knees bounce with it and the hips sway. The
  // upper arm turns outward first (x -90) so the elbow bends upward instead of forward.
  wave: {
    fadeIn: 0.4, fadeOut: 0.9, length: 3.2, arms: 'right', cooldown: 15, idle: 0.4, onAir: true,
    frame: (t) => {
      const amp = K(t, [0.35, 0], [0.6, 1], [2.3, 1], [2.85, 0.15]);
      const p = (t - 0.35) * Math.PI * 2 * 2.4;
      return {
        rightUpperArm: pose(['x', -90], ['z', 36 - 9 * bump(t, 0.2, 0.75)], ['y', 12]),
        rightLowerArm: pose(['y', 104 + 18 * amp * Math.sin(p)]),
        rightHand: pose(['y', 18 * amp * Math.sin(p - 1.3)]),
        ...fingers('right', OPEN, 8),
        head: add(['z', 8 + 3 * amp * Math.sin(p)], ['y', -8], ['x', -2]),
        neck: add(['z', 3]),
        spine: add(['z', -2]), chest: add(['z', -2], ['y', -4]),
      };
    },
    body: (t) => {
      const amp = K(t, [0.35, 0], [0.6, 1], [2.3, 1], [2.85, 0.15]);
      const sway = Math.sin((t - 0.35) * Math.PI * 2 * 1.2);
      return {
        weight: K(t, [0, 0], [0.45, -0.65], [2.5, -0.65], [3.1, -0.15]),
        x: 0.01 * sway * amp,
        bob: 4 * pulse(t, 0.05, 0.22, 0.45) + 2 * amp * (0.5 + 0.5 * sway),
      };
    },
    face: (t) => ({ happy: 0.7 * K(t, [0.1, 0], [0.45, 1]), openSmile: 0.45 * K(t, [0.3, 0], [0.55, 1], [1.8, 1], [2.4, 0]), blush: 0.55 }),
  },
  // A breath in, then a little bow from the hips with the hands together and the eyes shut, the knees
  // giving and the toes turning in; up again past upright, a small bounce, then a smile with the head
  // tilted, settling onto one leg.
  bow: {
    fadeIn: 0.35, fadeOut: 0.9, length: 3.0, arms: 'both', cooldown: 10,
    frame: (t) => {
      const d = B(t, [0.2, 0], [0.65, 1], [1.1, 1], [1.6, 0]);
      const inhale = bump(t, 0, 0.4);
      const tilt = K(t, [1.45, 0], [1.9, 1]);
      return {
        ...arms(LOW), ...bothHands(SOFT),
        spine: add(['x', 15 * d - 2 * inhale]), chest: add(['x', 10 * d - 2 * inhale]), neck: add(['x', 4 * d]),
        head: add(['x', 11 * d], ['z', 8 * tilt]),
      };
    },
    body: (t) => {
      const d = B(t, [0.2, 0], [0.65, 1], [1.1, 1], [1.6, 0]);
      return {
        bob: 5 * Math.max(0, d) + 3 * bump(t, 1.45, 1.95),
        rise: 0.15 * bump(t, 0, 0.4),
        weight: K(t, [1.7, 0], [2.4, -0.5]),
        right: { yaw: 7 * Math.max(0, d) }, left: { yaw: -7 * Math.max(0, d) },
      };
    },
    face: (t) => ({
      calmEyes: K(t, [0.15, 0], [0.4, 1], [1.2, 1], [1.45, 0]),
      happy: 0.75 * K(t, [1.35, 0], [1.75, 1]),
      blush: 0.6 * K(t, [1.25, 0], [1.7, 1]),
    }),
    gaze: (t) => [0, 18, K(t, [0.1, 0], [0.45, 1], [1.15, 1], [1.45, 0])],
  },
  // Two quick nods, the second smaller, the knees bobbing with them, and a smile; then onto one leg.
  nod: {
    fadeIn: 0.2, fadeOut: 0.6, length: 1.8, cooldown: 3,
    frame: (t) => {
      const n = pulse(t, 0.08, 0.16, 0.3) + 0.75 * pulse(t, 0.55, 0.15, 0.3);
      return { head: add(['x', 13 * n], ['z', 3 * K(t, [0.05, 0], [0.5, 1])]), neck: add(['x', 4 * n]), chest: add(['x', 3 * n]) };
    },
    body: (t) => ({ bob: 3.5 * (pulse(t, 0.08, 0.16, 0.3) + 0.75 * pulse(t, 0.55, 0.15, 0.3)), weight: K(t, [0.9, 0], [1.6, 0.35]) }),
    face: (t) => ({ happy: 0.55 * K(t, [0.2, 0], [0.6, 1]) }),
  },
  // Head over to one side as with a question, the shoulder on that side coming up, the hips going the
  // other way (the whole body in a curve); eyes stay on the viewer, mouth a small "o".
  tilt: {
    fadeIn: 0.3, fadeOut: 0.8, length: 2.6, cooldown: 6, idle: 0.5, onAir: true,
    frame: (t) => {
      const k = B(t, [0.05, 0], [0.5, 1], [1.9, 1], [2.5, 0.25]);
      return {
        head: add(['z', 15 * k], ['y', 6 * k], ['x', -4 * k]),
        neck: add(['z', 5 * k]),
        chest: add(['z', -2.5 * k]),
        rightShoulder: add(['z', -5 * k]),
      };
    },
    body: (t) => ({ weight: -0.6 * K(t, [0, 0], [0.55, 1], [1.9, 1], [2.5, 0.3]), bob: 2 * pulse(t, 0.05, 0.18, 0.45) }),
    face: (t) => ({ smallO: 0.55 * K(t, [0.2, 0], [0.5, 1], [1.4, 1], [1.8, 0.2]), happy: 0.3 * K(t, [1.3, 0], [1.7, 1]) }),
  },
  // A finger on the chin, the other arm across the body holding the elbow; standing on the left leg with
  // the right toes on the floor, head tilted and swaying, eyes up and aside, lips pursed. Also held while
  // the broadcast waits for an answer.
  think: {
    fadeIn: 0.6, fadeOut: 0.8, length: 3.2, arms: 'both', cooldown: 8, idle: 0.5, onAir: true,
    frame: (t) => {
      const sway = sin(t, 0.4);
      return {
        rightUpperArm: pose(['z', 76], ['y', 28]),
        rightLowerArm: pose(['y', 132]),
        rightHand: pose(['z', -15]),
        ...fingers('right', POINT),
        leftUpperArm: flip(pose(['z', 85], ['y', 69])),
        leftLowerArm: flip(pose(['y', 88])),
        ...fingers('left', SOFT),
        head: add(['x', -5 + 1.5 * sway], ['y', -8], ['z', -8 + 4 * sway]),
        neck: add(['z', -3]),
        chest: add(['z', 1.5 * sway]),
      };
    },
    body: (t) => {
      const k = K(t, [0.1, 0], [0.8, 1]);
      return { weight: -0.6 * k, x: 0.004 * sin(t, 0.3), right: { heel: 16 * k, z: 0.025 * k, yaw: 6 * k } };
    },
    face: (t) => ({ pout: 0.5 * K(t, [0.4, 0], [0.8, 1]) }),
    gaze: (t) => [-14 + 5 * sin(t, 0.3), -13],
  },
  // Bouncing on the knees with fists up under the chin, the heels coming up at the top of each bounce,
  // swaying from leg to leg, eyes shut in a big smile; it calms down before it ends.
  happy: {
    fadeIn: 0.3, fadeOut: 0.9, length: 3.0, arms: 'both', cooldown: 6,
    frame: (t) => {
      const env = K(t, [0, 0], [0.3, 1], [2.3, 1], [2.85, 0]);
      const c = Math.abs(Math.sin(Math.PI * 2.2 * t)) * env;
      const s = sin(t, 1.1) * env;
      return {
        ...mirrored({ rightUpperArm: pose(['x', 15], ['z', 75 - 7 * (env - c)], ['y', -3]), rightLowerArm: pose(['y', 136 - 8 * (env - c)]) }),
        ...bothHands(FIST),
        head: add(['z', 8 * s], ['x', -3 * env + 3 * c]),
        neck: add(['z', 3 * s]),
        chest: add(['z', -3 * s]),
        spine: add(['z', -1.5 * s], ['x', -2 * env]),
      };
    },
    body: (t) => {
      const env = K(t, [0, 0], [0.3, 1], [2.3, 1], [2.85, 0]);
      const c = Math.abs(Math.sin(Math.PI * 2.2 * t));
      return { bob: 6 * c * env, rise: 0.4 * (1 - c) * env, x: 0.012 * sin(t, 1.1) * env, weight: 0.4 * sin(t, 1.1) * env };
    },
    face: (t) => ({ happy: K(t, [0, 0], [0.25, 1], [2.5, 1], [2.9, 0.6]), openSmile: 0.65 * K(t, [0, 0], [0.3, 1], [2.3, 1], [2.8, 0]), blush: 0.85 }),
  },
  // A start: the weight onto the left leg and the right foot a step back, up on the toes and leaning
  // away with the hands up at the chest, eyes wide, mouth open; then the foot comes back and the hands
  // go down.
  surprised: {
    fadeIn: 0.2, fadeOut: 0.9, length: 2.4, arms: 'both', cooldown: 6,
    armsAt: (t) => K(t, [0, 0], [0.18, 1], [1.4, 1], [2.1, 0.3]),
    frame: (t) => {
      const j = B(t, [0, 0], [0.18, 1], [0.9, 1], [1.6, 0.25]);
      return {
        ...arms(CHEST, K(t, [0, 0], [0.18, 1], [1.4, 1], [2.1, 0.3])), ...bothHands(OPEN, 10),
        head: add(['x', -10 * j]), neck: add(['x', -3 * j]), chest: add(['x', -6 * j]), spine: add(['x', -2 * j]),
        rightShoulder: add(['z', -9 * j]), leftShoulder: add(['z', 9 * j]),
      };
    },
    body: (t) => {
      const away = K(t, [0.12, 0], [0.36, 1], [1.45, 1], [1.85, 0]);
      return {
        weight: K(t, [0, 0], [0.12, -0.55], [0.36, -0.55], [0.6, 0.4], [1.2, 0.4], [1.45, -0.5], [1.85, -0.5], [2.25, 0]),
        rise: 0.45 * K(t, [0, 0], [0.14, 1], [0.42, 0]),
        right: { z: -0.07 * away, y: stepUp(t, 0.12, 0.36) + stepUp(t, 1.45, 1.85) },
      };
    },
    face: (t) => ({
      surprised: 0.9 * K(t, [0, 0], [0.1, 1], [0.9, 1], [1.4, 0.3]),
      smallO: 0.75 * K(t, [0, 0], [0.12, 1], [0.8, 1], [1.3, 0]),
      blush: 0.35,
    }),
  },
  // Head and shoulders down, hands together low, knees in and soft; standing on the left leg, the right
  // foot on its toes swivelling from side to side (sulking); a pout and a little sigh.
  sad: {
    fadeIn: 0.6, fadeOut: 1.0, length: 3.6, arms: 'both', cooldown: 8,
    frame: (t) => {
      const d = K(t, [0, 0], [0.7, 1], [3.0, 1], [3.6, 0.5]);
      const sigh = bump(t, 1.4, 2.4);
      return {
        ...arms(LOW), ...bothHands(SOFT),
        head: add(['x', 15 * d], ['z', 5 * d]), neck: add(['x', 5 * d]), chest: add(['x', 7 * d - 2 * sigh]),
        rightShoulder: add(['z', 5 * d - 4 * sigh]), leftShoulder: add(['z', -5 * d + 4 * sigh]),
      };
    },
    body: (t) => {
      const d = K(t, [0, 0], [0.7, 1], [3.0, 1], [3.6, 0.5]);
      const toe = K(t, [0.8, 0], [1.15, 1], [2.6, 1], [2.95, 0]);
      return {
        bob: 4 * d, weight: -0.45 * d, kneesIn: 7 * d,
        right: { heel: 24 * toe, yaw: (8 + 12 * sin(t - 1.15, 0.9)) * toe },
        left: { yaw: -5 * d },
      };
    },
    face: () => ({ sad: 0.8, pout: 0.55, calmEyes: 0.3 }),
    gaze: () => [5, 18],
  },
  // Shaking the head with the eyes squeezed shut and a pout (no, no!), the shoulders and hips turning
  // against it and the weight rocking with it.
  shake: {
    fadeIn: 0.2, fadeOut: 0.6, length: 1.8, cooldown: 6,
    frame: (t) => {
      const s = sin(t, 2.6) * K(t, [0, 0.5], [0.15, 1], [0.9, 1], [1.4, 0]);
      return { head: add(['y', 15 * s], ['z', -3 * s]), neck: add(['y', 5 * s]), chest: add(['y', -4 * s]) };
    },
    body: (t) => {
      const s = sin(t, 2.6) * K(t, [0, 0.5], [0.15, 1], [0.9, 1], [1.4, 0]);
      return { yaw: -3 * s, weight: 0.15 * s, bob: 1.5 * s * s };
    },
    face: (t) => ({ squeeze: K(t, [0, 0], [0.1, 1], [1.2, 1], [1.5, 0]), pout: 0.6 }),
  },

  // ---- On its own -----------------------------------------------------------------------------------
  // Hands joined above the head and up on the toes, leaning to one side and the other (the hips going
  // the other way) with the eyes squeezed shut; down on the heels with a bounce, a relieved smile, the
  // weight onto one leg.
  stretch: {
    fadeIn: 0.9, fadeOut: 1.1, length: 5.2, arms: 'both', cooldown: 70, idle: 1, onAir: true,
    frame: (t) => {
      const top = K(t, [0.6, 0], [1.1, 1], [2.6, 1], [3.0, 0]);
      const lean = K(t, [1.1, 0], [1.5, 1], [2.0, -1], [2.5, 0]);
      const down = K(t, [2.7, 0], [3.3, 1]);
      const shiver = sin(t, 6) * bump(t, 1.2, 2.6);
      return {
        ...mirrored(armBetween([-75, -62 - 4 * bump(t, 0.6, 1.3) + 1.5 * shiver, 9, 72], [0, 72, 6, 14], down)),
        ...bothHands(SOFT),
        spine: add(['x', -3 * top], ['z', 7 * lean]), chest: add(['x', -4 * top], ['z', 6 * lean]),
        neck: add(['x', -3 * top]), head: add(['x', -10 * top], ['z', 4 * lean]),
        rightShoulder: add(['z', 4 * bump(t, 3.3, 4.4)]), leftShoulder: add(['z', -4 * bump(t, 3.3, 4.4)]),
      };
    },
    body: (t) => ({
      rise: 0.8 * K(t, [0.5, 0], [1.1, 1], [2.5, 1], [3.0, 0]),
      bob: 5 * bump(t, 2.95, 3.7),
      weight: K(t, [3.3, 0], [4.2, 0.55]),
    }),
    face: (t) => ({
      squeeze: K(t, [0.6, 0], [0.95, 1], [2.7, 1], [3.0, 0]),
      pout: 0.4 * K(t, [0.7, 0], [1.0, 1], [2.6, 1], [2.9, 0]),
      happy: 0.7 * K(t, [3.0, 0], [3.4, 1]),
    }),
  },
  // Eyes first, then the head, then the body: the weight goes onto the leg on that side and the hips
  // turn after it; to the left, to the right, back to the viewer with a smile.
  look: {
    fadeIn: 0.35, fadeOut: 0.9, length: 4.4, cooldown: 25, idle: 1.4, onAir: true,
    frame: (t) => {
      const side = K(t, [0.25, 0], [0.7, 1], [1.5, 1], [2.1, -1], [3.0, -1], [3.6, 0]);
      return { chest: add(['y', 6 * side]), spine: add(['y', 2 * side]), head: add(['z', -4 * side]) };
    },
    body: (t) => {
      const side = K(t, [0.35, 0], [0.85, 1], [1.6, 1], [2.25, -1], [3.1, -1], [3.7, 0]);
      return { weight: -0.5 * side, yaw: 8 * side, bob: 2 * (bump(t, 0.3, 0.8) + bump(t, 1.7, 2.2) + bump(t, 3.2, 3.7)) };
    },
    gaze: (t) => [
      K(t, [0, 0], [0.35, 32], [1.3, 32], [1.75, -30], [2.8, -30], [3.3, 0]),
      K(t, [0, 0], [0.35, 4], [1.3, 2], [1.75, 4], [2.8, 4], [3.3, 0]),
      K(t, [3.3, 1], [3.8, 0]),
    ],
    face: (t) => ({ smallO: 0.3 * K(t, [0.3, 0], [0.6, 1], [2.8, 1], [3.2, 0]), happy: 0.65 * K(t, [3.3, 0], [3.7, 1]) }),
  },
  // Hand in front of the mouth, leaning back and up on the toes a little, mouth wide and eyes squeezed
  // shut; a shiver, then the knees give a little and the weight goes onto one leg.
  yawn: {
    fadeIn: 0.5, fadeOut: 1.0, length: 4.4, arms: 'right', cooldown: 90, idle: 0.8, onAir: true,
    frame: (t) => {
      const y = K(t, [0.3, 0], [0.9, 1], [2.1, 1], [2.7, 0]);
      const shiver = bump(t, 2.7, 3.3);
      return {
        rightUpperArm: pose(['z', 74], ['y', 46]),
        rightLowerArm: pose(['y', 144]),
        rightHand: pose(['z', -10]),
        ...fingers('right', SOFT),
        head: add(['x', -11 * y], ['z', 4 * y]), neck: add(['x', -3 * y]), chest: add(['x', -4 * y]),
        rightShoulder: add(['z', -4 * y - 5 * shiver]), leftShoulder: add(['z', 4 * y + 5 * shiver]),
      };
    },
    body: (t) => ({
      rise: 0.3 * K(t, [0.3, 0], [0.9, 1], [2.1, 1], [2.7, 0]),
      bob: 4 * bump(t, 2.6, 3.4),
      weight: K(t, [3.0, 0], [3.8, 0.5]),
    }),
    face: (t) => {
      const y = K(t, [0.3, 0], [0.9, 1], [2.1, 1], [2.7, 0]);
      return { aa: 0.95 * y, squeeze: y, happy: 0.35 * K(t, [2.8, 0], [3.3, 1]) };
    },
    gaze: () => [0, -8],
  },
  // Standing on the left leg with the right knee forward, the right hand tucks the hair behind the ear,
  // the head tilting into it; a shy smile and a glance down.
  hair: {
    fadeIn: 0.55, fadeOut: 0.9, length: 3.6, arms: 'right', cooldown: 40, idle: 1, onAir: true,
    frame: (t) => {
      const slide = K(t, [0.6, 0], [1.6, 1]);
      return {
        rightUpperArm: pose(['x', -90], ['z', 18 - 6 * slide], ['y', 34 - 22 * slide]),
        rightLowerArm: pose(['y', 128 + 6 * slide]),
        ...fingers('right', SOFT),
        head: add(['z', 8], ['y', -8], ['x', 3]),
        chest: add(['z', -1.5]),
      };
    },
    body: (t) => {
      const k = K(t, [0.1, 0], [0.8, 1]);
      return { weight: -0.65 * k, right: { heel: 12 * k } };
    },
    face: (t) => ({ happy: 0.5 * K(t, [0.9, 0], [1.5, 1]), blush: 0.7 * K(t, [0.7, 0], [1.3, 1]) }),
    gaze: (t) => [-10, 12, K(t, [0, 1], [1.5, 1], [2.0, 0])],
  },
  // Humming to itself: hands behind the back, rocking from one leg to the other with the free heel up and
  // the knees giving as the weight crosses over, eyes shut, an ω mouth.
  sway: {
    fadeIn: 0.6, fadeOut: 1.1, length: 5.8, arms: 'both', cooldown: 30, idle: 1.2, onAir: true,
    frame: (t) => {
      const env = K(t, [0, 0], [0.6, 1], [5.0, 1], [5.6, 0.2]);
      const s = sin(t, 0.6) * env, c = Math.sin(t * Math.PI * 2 * 0.6 - 0.7) * env;
      return {
        ...arms(BEHIND),
        spine: add(['z', -1.5 * s]), chest: add(['z', -1 * s]), neck: add(['z', -2 * c]),
        head: add(['z', -7 * c], ['x', -2 + 2 * Math.abs(s)]),
      };
    },
    body: (t) => {
      const env = K(t, [0, 0], [0.6, 1], [5.0, 1], [5.6, 0.2]);
      const w = sin(t, 0.6);
      return {
        weight: 0.8 * w * env, bob: 3 * (1 - Math.abs(w)) * env,
        right: { heel: 14 * Math.max(0, -w) * env }, left: { heel: 14 * Math.max(0, w) * env },
      };
    },
    face: () => ({ calmEyes: 1, catMouth: 0.9, blush: 0.5 }),
  },
  // Dozing off: eyes closing, the head sinking twice and the knees going soft; waking with a start, the
  // left foot catching a step, then embarrassed: hands to the cheeks, knees and toes in, the foot back.
  doze: {
    fadeIn: 0.8, fadeOut: 1.1, length: 7.6, arms: 'both', cooldown: 180, idle: 0.5,
    armsAt: (t) => K(t, [4.0, 0], [4.4, 1], [6.2, 1], [6.8, 0]),
    frame: (t) => {
      const drop = K(t, [0, 0], [1.4, 0.35], [2, 0.25], [3.6, 1], [3.8, 1], [3.95, -0.2], [4.6, 0]);
      const wake = K(t, [3.85, 0], [4, 1], [5.4, 1], [6, 0]);
      const shy = K(t, [4.2, 0], [4.6, 1], [6.0, 1], [6.6, 0]);
      return {
        ...arms(CHEEKS, K(t, [4.0, 0], [4.4, 1], [6.2, 1], [6.8, 0])),
        ...bothHands(SOFT),
        head: add(['x', 22 * drop], ['y', 5 * wake * sin(t - 3.9, 2.2)], ['z', -7 * shy]),
        neck: add(['x', 8 * drop]), chest: add(['x', 4 * drop]), spine: add(['x', 2 * drop]),
      };
    },
    body: (t) => {
      const drop = K(t, [0, 0], [1.4, 0.35], [2, 0.25], [3.6, 1], [3.8, 1], [3.95, -0.2], [4.6, 0]);
      const shy = K(t, [4.3, 0], [4.7, 1], [6.2, 1], [6.6, 0]);
      const step = K(t, [3.95, 0], [4.2, 1], [6.55, 1], [7.0, 0]);
      return {
        bob: 6 * Math.max(0, drop),
        rise: 0.5 * K(t, [3.85, 0], [3.97, 1], [4.2, 1], [4.5, 0]),
        weight: K(t, [3.78, 0], [3.95, 0.6], [4.2, 0.6], [4.5, 0], [6.35, 0], [6.55, 0.55], [7.0, 0.55], [7.35, 0]),
        kneesIn: 9 * shy,
        left: { z: 0.04 * step, y: stepUp(t, 3.95, 4.2, 0.025) + stepUp(t, 6.55, 7.0, 0.025), yaw: -8 * shy },
        right: { yaw: 8 * shy },
      };
    },
    face: (t) => ({
      calmEyes: K(t, [0.2, 0], [1.2, 0.55], [2, 0.45], [3.4, 1], [3.86, 1], [3.98, 0]),
      aa: 0.12 * K(t, [2.6, 0], [3.2, 1], [3.86, 1], [3.95, 0]),
      surprised: K(t, [3.85, 0], [4, 0.8], [4.6, 0.3], [5, 0]),
      smallO: K(t, [3.85, 0], [4, 0.7], [4.6, 0]),
      blush: 0.95 * K(t, [4.1, 0], [4.6, 1], [6.2, 1], [6.8, 0]),
      happy: 0.6 * K(t, [4.5, 0], [4.9, 1], [6.2, 1], [6.8, 0]),
    }),
    gaze: (t) => [K(t, [4.6, 0], [4.9, -18], [5.4, -18], [5.7, 0]), K(t, [0, 14], [3.85, 14], [4.0, 0]), K(t, [5.6, 1], [6.0, 0])],
  },
  // Head to one side and the other with the eyes shut, the other shoulder dropping and the hips going
  // the other way; a shrug and a little bounce at the end.
  neck: {
    fadeIn: 0.5, fadeOut: 0.9, length: 5.0, cooldown: 60, idle: 0.8, onAir: true,
    frame: (t) => {
      const z = K(t, [0, 0], [0.8, 1], [1.5, 1], [2.4, -1], [3.1, -1], [3.8, 0]);
      const shrug = bump(t, 3.7, 4.4);
      return {
        head: add(['z', 17 * z], ['x', 3 + 2 * Math.abs(z)]), neck: add(['z', 7 * z]),
        rightShoulder: add(['z', 5 * Math.max(0, -z) - 7 * shrug]), leftShoulder: add(['z', -5 * Math.max(0, z) + 7 * shrug]),
      };
    },
    body: (t) => {
      const z = K(t, [0.1, 0], [0.9, 1], [1.6, 1], [2.5, -1], [3.2, -1], [3.9, 0]);
      return { weight: -0.4 * z, bob: 3 * bump(t, 3.7, 4.5) };
    },
    face: (t) => ({ calmEyes: 0.95 * K(t, [0.3, 0], [0.7, 1], [3.5, 1], [3.9, 0]), happy: 0.5 * K(t, [3.8, 0], [4.2, 1]) }),
  },
  // Standing on the left leg, the right hand raised in front: turning it over, wiggling the fingers, then
  // looking up at the viewer with a smile.
  hands: {
    fadeIn: 0.6, fadeOut: 0.9, length: 4.2, arms: 'right', cooldown: 45, idle: 0.7, onAir: true,
    frame: (t) => {
      const turn = K(t, [0.8, 0], [1.3, 1], [2.0, 1], [2.4, 0]);
      const wiggle = K(t, [0.9, 0], [1.1, 1], [2.3, 1], [2.6, 0]);
      const w = (i: number) => 0.35 + 0.35 * wiggle * Math.sin(t * 9 - i * 0.9);
      return {
        rightUpperArm: pose(['z', 68], ['y', 48]),
        rightLowerArm: pose(['y', 100]),
        rightHand: pose(['x', -50 * turn]),
        ...fingers('right', [0.3, w(1), w(2), w(3), w(4)]),
        head: add(['x', 14 * K(t, [0, 1], [2.6, 1], [3.1, 0.35])], ['y', -6], ['z', 5 * turn]),
      };
    },
    body: (t) => {
      const k = K(t, [0.2, 0], [0.9, 1]);
      return { weight: -0.55 * k, right: { heel: 8 * k } };
    },
    gaze: (t) => [-12, 26, K(t, [2.6, 1], [3.0, 0])],
    face: (t) => ({ smallO: 0.3 * K(t, [0.6, 0], [1.0, 1], [2.4, 1], [2.7, 0]), happy: 0.6 * K(t, [2.6, 0], [3.0, 1]) }),
  },

  // ---- Reactions to a click -------------------------------------------------------------------------
  // Head patted: eyes shut, an ω smile and a blush, sinking a little into the hand and swaying with it,
  // hands together, knees and toes in and one heel up (shy).
  pat: {
    fadeIn: 0.35, fadeOut: 0.9, length: 3.0, arms: 'both', cooldown: 0,
    frame: (t) => {
      const s = sin(t, 1.0) * K(t, [0.3, 0], [0.6, 1], [2.2, 1], [2.6, 0]);
      return {
        ...arms(LOW), ...bothHands(SOFT),
        head: add(['x', 9], ['z', 6 * s]), neck: add(['x', 3]), chest: add(['z', -2 * s]), spine: add(['z', -1 * s]),
        rightShoulder: add(['z', -3]), leftShoulder: add(['z', 3]),
      };
    },
    body: (t) => {
      const env = K(t, [0.15, 0], [0.6, 1], [2.3, 1], [2.8, 0]);
      const s = sin(t, 1.0) * env;
      return { bob: 4 * env, weight: -0.3 * env + 0.25 * s, kneesIn: 8 * env, right: { heel: 22 * env, yaw: 8 * env }, left: { yaw: -5 * env } };
    },
    face: () => ({ calmEyes: 1, catMouth: 0.85, blush: 0.9 }),
  },
  // Poked in the body: eyes squeezed shut, hands to the chest, up on the toes and the left foot a step
  // back; then a puzzled tilt, and the foot comes back.
  poke: {
    fadeIn: 0.2, fadeOut: 0.9, length: 2.4, arms: 'both', cooldown: 0,
    armsAt: (t) => K(t, [0, 0], [0.15, 1], [0.95, 1], [1.5, 0]),
    frame: (t) => {
      const f = B(t, [0, 0], [0.12, 1], [0.55, 0.6], [1.15, 0]);
      const q = B(t, [0.65, 0], [1.05, 1], [2.0, 0.6]);
      return {
        ...arms(CLUTCH, K(t, [0, 0], [0.15, 1], [0.95, 1], [1.5, 0])), ...bothHands(SOFT),
        spine: add(['x', -4 * f]), chest: add(['x', -5 * f]), head: add(['x', -6 * f], ['z', 12 * q]), neck: add(['z', 4 * q]),
        rightShoulder: add(['z', -8 * f]), leftShoulder: add(['z', 8 * f]),
      };
    },
    body: (t) => {
      const away = K(t, [0.18, 0], [0.4, 1], [1.65, 1], [2.05, 0]);
      return {
        rise: 0.5 * K(t, [0, 0], [0.15, 1], [0.4, 1], [0.65, 0]),
        weight: K(t, [0, 0], [0.18, 0.45], [0.4, 0.45], [0.62, -0.35], [1.4, -0.35], [1.65, 0.5], [2.05, 0.5], [2.35, 0]),
        left: { z: -0.05 * away, y: stepUp(t, 0.18, 0.4, 0.022) + stepUp(t, 1.65, 2.05, 0.022) },
      };
    },
    face: (t) => ({
      squeeze: K(t, [0, 0], [0.06, 1], [0.5, 1], [0.65, 0]),
      smallO: 0.6 * K(t, [0.6, 0], [0.85, 1], [1.6, 1], [1.9, 0]),
      blush: 0.5,
    }),
  },
  // A hand touched: it comes up a little, a lean to look at it, then a smile at the viewer.
  handR: touchedHand('right'),
  handL: touchedHand('left'),
  // A leg or foot touched: a start, knees together and bent, toes in and the right heel up, hands pressing
  // the skirt down, blushing.
  leg: {
    fadeIn: 0.2, fadeOut: 1.0, length: 2.6, arms: 'both', cooldown: 0,
    frame: (t) => {
      const f = B(t, [0, 0], [0.15, 1], [1.7, 1], [2.2, 0]);
      return {
        ...arms(SKIRT), ...bothHands(OPEN),
        spine: add(['x', 7 * f]), chest: add(['x', 5 * f]), head: add(['x', 14 * f]),
        rightShoulder: add(['z', -5 * f]), leftShoulder: add(['z', 5 * f]),
      };
    },
    body: (t) => {
      const f = B(t, [0, 0], [0.15, 1], [1.7, 1], [2.2, 0]);
      return { bob: 7 * f, kneesIn: 14 * f, weight: -0.4 * f, right: { yaw: 10 * f, heel: 18 * f }, left: { yaw: -10 * f } };
    },
    face: (t) => ({
      squeeze: K(t, [0, 0], [0.08, 1], [0.45, 1], [0.65, 0]),
      surprised: 0.5 * K(t, [0.45, 0], [0.65, 1], [1.5, 0]),
      blush: K(t, [0, 0], [0.3, 1]),
      pout: 0.5 * K(t, [0.75, 0], [1.15, 1]),
    }),
    gaze: () => [0, 30],
  },
  // Poked again and again: "hmph!" A stamp of the right foot, then turning away (hips and all) with the
  // eyes shut, a pout, stiff arms and fists; a peek back at the viewer, then away again.
  annoyed: {
    fadeIn: 0.25, fadeOut: 0.9, length: 3.0, arms: 'both', cooldown: 0,
    frame: (t) => {
      const away = B(t, [0.33, 0], [0.55, 1], [2.2, 1], [2.6, 0]);
      const jerk = bump(t, 1.75, 2.0);
      return {
        ...arms(STIFF), ...bothHands(FIST),
        head: add(['y', (20 + 4 * jerk) * away], ['x', -7 * away], ['z', -4 * away]),
        neck: add(['y', 6 * away]), chest: add(['y', 5 * away]),
        rightShoulder: add(['z', -6 * away]), leftShoulder: add(['z', 6 * away]),
      };
    },
    body: (t) => {
      const away = B(t, [0.33, 0], [0.55, 1], [2.2, 1], [2.6, 0]);
      const lift = K(t, [0.16, 0], [0.3, 1], [0.37, 0]);
      return {
        weight: K(t, [0, 0], [0.22, -0.7], [0.4, -0.7], [0.68, 0]),
        right: { y: 0.07 * lift, z: 0.02 * lift },
        bob: 5 * pulse(t, 0.37, 0.06, 0.35),
        yaw: 12 * away,
      };
    },
    face: (t) => ({
      calmEyes: K(t, [0.33, 0], [0.48, 1], [1.15, 1], [1.25, 0], [1.75, 0], [1.85, 1], [2.2, 1], [2.4, 0]),
      glare: 0.75 * K(t, [1.15, 0], [1.25, 1], [1.7, 1], [1.8, 0]),
      pout: 1, angry: 0.6, blush: 0.6,
    }),
    gaze: (t) => [-30, -3, K(t, [1.2, 0], [1.3, 1], [1.7, 1], [1.8, 0])],
  },
};

interface Playing { name: ActionName; def: Def; t: number; end: number }

export interface ActionSample {
  name: ActionName;
  frame: Frame;
  /** 0..1, eased in and out (body, head and face) */
  weight: number;
  /** the arms' and the hands' weights: on the way back they follow the body a moment later */
  limbs: number;
  hands: number;
  arms: Def['arms'];
  /** how much the arms are used now (0..1), with their weight */
  armsWeight: number;
  body: BodyKeys | null;
  face: Record<string, number> | null;
  /** [yaw, pitch] in degrees and its own weight (to be taken with the action's) */
  gaze: [number, number, number] | null;
}

export function actionInfo(name: ActionName) {
  const d = DEFS[name];
  return { length: d.length, arms: d.arms, idle: d.idle || 0, onAir: !!d.onAir };
}

/** How long after the body the arms and the hands come back (delay, and how much longer they take). */
const ARMS_LAG = { delay: 0.12, stretch: 1.25 };
const HANDS_LAG = { delay: 0.2, stretch: 1.45 };
const lagEnd = (fadeOut: number, lag: { delay: number; stretch: number }) => lag.delay + (lag.stretch - 1) * fadeOut;

export class ActionPlayer {
  private playing: Playing[] = [];
  private lastAt = new Map<ActionName, number>();
  private clock = 0;
  /** Called when an action starts (shown in the panels) */
  onPlay?: (name: ActionName) => void;

  get active() {
    return this.playing.length > 0;
  }

  /** The action playing now (the newest one). */
  get current(): ActionName | null {
    const p = this.playing[this.playing.length - 1];
    return p && p.t < p.end ? p.name : null;
  }

  /** Whether it may be chosen automatically now (not shown in the last while). */
  ready(name: ActionName) {
    const at = this.lastAt.get(name);
    return at === undefined || this.clock - at >= DEFS[name].cooldown;
  }

  /** Plays an action; one already playing fades out. hold: until release(). */
  play(name: ActionName, hold = false) {
    for (const p of this.playing) this.release(p.name);
    const def = DEFS[name];
    this.playing.push({ name, def, t: 0, end: hold ? Infinity : def.length });
    this.lastAt.set(name, this.clock);
    this.onPlay?.(name);
  }

  /** Ends an action (a held one, or one still playing) with its fade-out. */
  release(name?: ActionName) {
    for (const p of this.playing) {
      if (name && p.name !== name) continue;
      p.end = Math.min(p.end, Math.max(p.t, p.def.fadeIn) + p.def.fadeOut);
    }
  }

  isPlaying(name: ActionName) {
    return this.playing.some((p) => p.name === name && p.t < p.end);
  }

  update(dt: number) {
    this.clock += dt;
    for (const p of this.playing) p.t += dt;
    // Kept until the hands are back too.
    this.playing = this.playing.filter((p) => p.t < p.end + lagEnd(p.def.fadeOut, HANDS_LAG));
  }

  stop() {
    this.playing = [];
  }

  /** The actions playing now with their weights. */
  sample(): ActionSample[] {
    return this.playing.map((p) => {
      const { fadeIn, fadeOut } = p.def;
      const into = smooth(p.t / fadeIn);
      const out = (lag?: { delay: number; stretch: number }) =>
        p.end === Infinity ? 1 : lag ? smooth((p.end + lagEnd(fadeOut, lag) - p.t) / (fadeOut * lag.stretch)) : smooth((p.end - p.t) / fadeOut);
      const w = Math.min(into, out());
      const limbs = Math.min(into, out(ARMS_LAG));
      const g = p.def.gaze ? p.def.gaze(p.t) : null;
      return {
        name: p.name,
        frame: p.def.frame(p.t),
        weight: w,
        limbs,
        hands: Math.min(into, out(HANDS_LAG)),
        arms: p.def.arms,
        armsWeight: p.def.arms ? limbs * (p.def.armsAt ? p.def.armsAt(p.t) : 1) : 0,
        body: p.def.body ? p.def.body(p.t) : null,
        face: p.def.face ? p.def.face(p.t) : null,
        gaze: g ? [g[0], g[1], g[2] ?? 1] : null,
      };
    });
  }
}
