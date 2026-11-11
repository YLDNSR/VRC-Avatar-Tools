// The avatar on its own: a desktop character that stands at ease (arms down and swaying a little, now and
// then hands together in front or behind the back, weight from one leg to the other and now and then the
// free foot set a little forward), breathes, blinks, looks at the viewer and around (eyes first, the head
// following), makes small moves now and then (a smile at the viewer, a head tilt, a little nod, up on the
// toes) and sometimes does something (actions.ts). The whole body takes part: the hips keep the balance
// and the legs follow with IK, the feet staying where they stand (body.ts); while the broadcast runs the
// lower body is taken down, as the stream shows the upper body. The autonomous broadcast adds lip sync, an
// emotion face per line and reaction gestures through `driver`.
// Everything is added last in the frame, on top of whatever posed the bones (motions, the VRChat animator,
// cursor gaze), and taken off exactly at the start of the next one (bones.ts), so those keep working.
import * as THREE from 'three';
import type { VRMHumanBoneName } from '@pixiv/three-vrm';
import type { App } from '../app';
import type { Avatar } from '../avatar';
import { general } from '../settings';
import { VrcAnimator } from '../vrcAnimator';
import { fingerBones } from '../../shared/bones';
import { BoneWriter, pose, mirrored, type BoneMove, type Frame } from './bones';
import { ActionPlayer, GESTURES, IDLE_ACTIONS, actionInfo, type ActionName, type ActionSample } from './actions';
import { FACES, type FaceCandidate } from './faces';
import { Body, LegRig, type BodyKeys } from './body';
import { mateFlag } from './flag';
import { mate, ACTION_GAPS } from './settings';

/** What the autonomous broadcast tells the motion. */
export interface LifeDriver {
  /** The broadcast runs, or the avatar is still talking */
  live(): boolean;
  /** Idle motion while live (the broadcast's own switch) */
  idle(): boolean;
  voice: { level: number; vowels: { A: number; I: number; U: number; E: number; O: number }; speaking: boolean };
  lipSync(): number;
  /** Emotion of the line being spoken ('neutral', 'happy', …), shown when emotions() */
  emotion(): string;
  emotions(): boolean;
  /** Waiting for the LLM's answer: the thinking pose */
  thinking(): boolean;
  /** Reaction gestures (and actions on their own) allowed */
  gestures(): boolean;
}

const LAYER = 'mate';
const MOUTH: ['A' | 'I' | 'U' | 'E' | 'O', string][] = [['A', 'aa'], ['I', 'ih'], ['U', 'ou'], ['E', 'ee'], ['O', 'oh']];
const EMOTIONS = ['happy', 'sad', 'angry', 'surprised', 'relaxed'];
const ARM_BONES = new Set<string>(['leftShoulder', 'rightShoulder', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftHand', 'rightHand']);
const LEG_BONES = new Set<string>(['leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg', 'leftFoot', 'rightFoot', 'leftToes', 'rightToes']);
const HAND_BONES = new Set<string>(['leftHand', 'rightHand']);
/** How much each bone's forward / sideways tilt moves the upper body's weight (for balance) */
const LEAN_BONES: [VRMHumanBoneName, number][] = [['spine', 1], ['chest', 0.9], ['upperChest', 0.9], ['neck', 0.4], ['head', 0.25]];
const FINGER = /^(left|right)(Thumb|Index|Middle|Ring|Little)/;
const DEG = Math.PI / 180;

// ---- Standing poses ----------------------------------------------------------------------------------

export type Stance = 'side' | 'front' | 'back';

/** Arms hanging relaxed at the sides (instead of the T-pose). */
const SIDE: Frame = mirrored({
  rightUpperArm: pose(['z', 74], ['y', 6]),
  rightLowerArm: pose(['y', 14]),
});
/** Hands held together in front. */
const FRONT: Frame = mirrored({
  rightUpperArm: pose(['x', 40], ['z', 70], ['y', 18]),
  rightLowerArm: pose(['y', 62]),
});
/** Hands behind the back: the upper arm turned so the elbow bends toward the back. */
const BACK: Frame = mirrored({
  rightUpperArm: pose(['x', 130], ['z', 70], ['y', -16]),
  rightLowerArm: pose(['y', 80]),
});
export const STANCES: Record<Stance, Frame> = { side: SIDE, front: FRONT, back: BACK };

/** Fingers a little bent, as in a relaxed hand: curl per joint [thumb, index, middle, ring, little]. */
const RELAXED: [number, number, number][] = [[10, 8, 6], [8, 12, 6], [12, 16, 8], [16, 20, 10], [20, 24, 12]];

// ---- Small helpers -------------------------------------------------------------------------------------

const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
/** Eased in and out, passing the target by about 9 % and settling back (starts from rest). */
const back = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x) + 7 * x * x * (1 - x) * (1 - x));
/** 0 → 1 → 0 between t0 and t1. */
const bump = (t: number, t0: number, t1: number) => (t <= t0 || t >= t1 ? 0 : Math.sin((Math.PI * (t - t0)) / (t1 - t0)) ** 2);
const rand = (a: number, b: number) => a + Math.random() * (b - a);

/**
 * Where a foot stands, from where the avatar's own pose puts it: outward and forward (metres for a small
 * avatar, scaled to the avatar's legs) and the toes turned out (degrees).
 */
interface Place { out: number; fwd: number; yaw: number }
type Footing = 'open' | 'wide' | 'narrow' | 'stagger';
/** Ways of standing [right foot, left foot], and how likely each is chosen. */
const FOOTINGS: Record<Footing, { feet: [Place, Place]; chance: number }> = {
  /** About hip width, toes a little out: the usual way */
  open: { feet: [{ out: 0.032, fwd: 0, yaw: 7 }, { out: 0.032, fwd: 0, yaw: 7 }], chance: 3 },
  /** Wide apart */
  wide: { feet: [{ out: 0.055, fwd: 0.005, yaw: 10 }, { out: 0.055, fwd: -0.005, yaw: 10 }], chance: 1 },
  /** Close together, toes a little in */
  narrow: { feet: [{ out: 0.01, fwd: 0, yaw: -3 }, { out: 0.01, fwd: 0, yaw: -3 }], chance: 1 },
  /** The right foot a little forward (the other way round half of the time) */
  stagger: { feet: [{ out: 0.028, fwd: 0.055, yaw: 9 }, { out: 0.032, fwd: -0.02, yaw: 6 }], chance: 2 },
};
const HOME: Place = { out: 0, fwd: 0, yaw: 0 };
const lerpPlace = (a: Place, b: Place, k: number): Place => ({ out: a.out + (b.out - a.out) * k, fwd: a.fwd + (b.fwd - a.fwd) * k, yaw: a.yaw + (b.yaw - a.yaw) * k });
const placeDiff = (a: Place, b: Place) => Math.hypot(a.out - b.out, a.fwd - b.fwd) + Math.abs(a.yaw - b.yaw) * 0.002;
const footState = () => ({ from: HOME, to: HOME, p: 1, lift: 0, liftFrom: 0 });

/** Small moves while idle: how likely each one is, and how long it lasts (min, max seconds). */
type SmallMove = 'smile' | 'tilt' | 'nod' | 'toes' | 'rock' | 'shrug' | 'pop';
const SMALL_MOVES: [SmallMove, number, number, number][] = [
  ['smile', 3, 2.6, 4.5], ['tilt', 2, 2, 3.5], ['nod', 1.2, 0.9, 0.9], ['toes', 1, 1.3, 1.3], ['rock', 1.2, 3.5, 5], ['shrug', 0.8, 0.9, 0.9],
  ['pop', 1, 1.8, 2.6],
];

interface SmallOut {
  face: Record<string, number>;
  /** degrees: head roll (+ = toward the avatar's right) and pitch (+ = down), chest roll, shoulders up */
  roll: number; pitch: number; chestRoll: number; shoulders: number;
  /** the lower body (hips, weight, knees, feet), taken by `amount` (0..1, eased in and out) */
  body: BodyKeys;
  amount: number;
}

/** Smooth 1D gradient noise, about -1..1 (another curve per seed). */
function noise(t: number, seed: number) {
  const grad = (i: number) => {
    const s = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453;
    return (s - Math.floor(s)) * 2 - 1;
  };
  const i = Math.floor(t), f = t - i;
  const u = f * f * f * (f * (f * 6 - 15) + 10);
  return 2 * (grad(i) * f * (1 - u) + grad(i + 1) * (f - 1) * u);
}

/** Critically damped spring: eases toward the target without overshooting. */
class Spring {
  x = 0;
  v = 0;
  step(target: number, omega: number, dt: number) {
    const f = 1 + 2 * dt * omega;
    const oo = omega * omega, hoo = dt * oo, hhoo = dt * hoo;
    const inv = 1 / (f + hhoo);
    const x = (f * this.x + dt * this.v + hhoo * target) * inv;
    this.v = (this.v + hoo * (target - this.x)) * inv;
    this.x = x;
    return x;
  }
  reset() { this.x = 0; this.v = 0; }
}

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();

export class LifeMotion {
  readonly actions = new ActionPlayer();
  driver: LifeDriver | null = null;
  private bones = new BoneWriter();
  private avatar: Avatar | null = null;
  /** Morph / expression keys of each face, with their strengths */
  private keys = new Map<string, [string, number][]>();
  private layer = new Map<string, number>();
  private weights = new Map<string, number>();
  /** Idle motion 0..1 (eased on and off) */
  private fade = 0;
  private applied = false;
  private droveEyes = false;
  private t = 0;
  /** The lower body: legs solved with IK, and what the motions ask of it this frame */
  private rig = new LegRig();
  private body = new Body();
  /** The weight shift shown this frame (-1..1, + = on the right leg) */
  private weightNow = 0;
  /** The free foot set a little forward while standing on the other leg: which one, and its step (0 → 1) */
  private restFoot = { side: 'right' as 'right' | 'left', from: 0, to: 0, p: 1, decided: false, lift: 0, liftFrom: 0 };
  /** Where each foot stands (a way of standing, FOOTINGS) and its step there */
  private feet = { right: footState(), left: footState() };
  /**
   * A new way of standing being taken: the feet still to move, one at a time, each after the weight has
   * gone onto the other leg. The first one (open) settles the avatar in once it starts moving.
   */
  private footing = { name: 'open' as Footing, queue: [] as ('right' | 'left')[], to: { right: HOME, left: HOME }, phase: 'none' as 'none' | 'shift' | 'step', next: 0.8, settled: false };
  /** How far the feet stand apart this frame (metres, each foot beyond the avatar's pose) */
  private footWidth = 0;
  /** The whole body (1) or mostly the upper body (0, broadcast or switch off), eased */
  private fullK = 1;
  /** The avatar's legs against a small avatar's (for distances) */
  private size = 1;
  // small moves
  private small = { kind: null as SmallMove | null, t: 0, length: 0, side: 1, next: rand(4, 8), fade: 0, last: null as SmallMove | null, smileSoon: false };
  /** Per arm bone: 1 while no animation poses it, easing to 0 while one does */
  private free = new Map<string, number>();
  /** 1 while no animation moves the body, easing to 0 while one does */
  private still = 1;
  // face
  private blink = { next: 2.5, phase: -1, double: false };
  private emotionHold = 0;
  // standing
  private stance: Stance = 'side';
  private prevStance: Stance = 'side';
  private stanceK = 1;
  private nextStance = rand(30, 60);
  private weight = new Spring();
  private weightTo = 0;
  private nextWeight = rand(4, 9);
  private breath = { p: 0, period: 4.2, sigh: 0 };
  /** The action playing in the last frame (to settle after it ends) */
  private lastAction: ActionName | null = null;
  // gaze: radians, yaw + = the avatar's left, pitch + = down
  private look = { yaw: 0, pitch: 0, next: 1.5, onViewer: true, offYaw: 0, offPitch: 0 };
  private eye = { yaw: 0, pitch: 0 };
  private micro = { yaw: 0, pitch: 0, next: 0.6 };
  private headYaw = new Spring();
  private headPitch = new Spring();
  private nod = 0;
  // actions on their own
  private nextAction = rand(15, 30);
  private lastActions: ActionName[] = [];
  private thinkingFor = 0;
  /** The thinking pose was started for the LLM (not by a button) */
  private thinkHeld = false;

  /** Start of the frame, before anything poses the bones: takes last frame's motion off. */
  beginFrame() {
    this.bones.restore();
  }

  /** Something is going on (keeps the frame rate up). */
  busy() {
    return this.applied || this.actions.active;
  }

  /** The idle motion runs now (desktop character switch, or the broadcast's own). */
  idleOn() {
    const d = this.driver;
    return d?.live() ? d.idle() : mateFlag.enabled;
  }

  /** Another way of standing (also on request). */
  setStance(s: Stance) {
    if (s === this.stance) return;
    this.prevStance = this.stance;
    this.stance = s;
    this.stanceK = 0;
    this.nextStance = rand(35, 80);
  }

  get currentStance() {
    return this.stance;
  }

  /** Something touched it: look at the viewer, and nothing on its own for a while. */
  attention() {
    const l = this.look;
    l.onViewer = true;
    l.offYaw = 0;
    l.offPitch = 0;
    l.next = rand(3, 5);
    this.nextAction = Math.max(this.nextAction, rand(15, 25));
  }

  update(app: App, dt: number) {
    const a = app.avatar;
    if (a !== this.avatar) this.attach(a);
    if (!a) return;
    const d = this.driver;
    const live = !!d?.live();
    const idle = this.idleOn();
    this.actions.update(dt);
    // After an action, settle the way people do: the weight goes onto a leg soon, and a deeper breath out.
    const current = this.actions.current;
    if (this.lastAction && !current) {
      this.nextWeight = Math.min(this.nextWeight, rand(0.5, 1.4));
      if (this.breath.sigh !== 2) this.breath.sigh = 1;
    }
    this.lastAction = current;
    this.fade += ((idle ? 1 : 0) - this.fade) * Math.min(1, dt * 2.5);
    const speaking = !!d?.voice.speaking;
    if (!idle && this.fade < 0.01 && !this.actions.active && !speaking && !live) { if (this.applied) this.reset(); return; }
    this.applied = true;
    this.t += dt;
    this.apply(app, a, dt, live, idle);
    this.bones.seal();
  }

  private attach(a: Avatar | null) {
    this.bones.forget();
    this.keys.clear();
    this.weights.clear();
    this.actions.stop();
    this.avatar = a;
    this.applied = false;
    this.headYaw.reset();
    this.headPitch.reset();
    this.weight.reset();
    this.stance = this.prevStance = 'side';
    this.stanceK = 1;
    this.free.clear();
    this.still = 1;
    this.nextAction = rand(15, 30);
    this.small.kind = null;
    if (!a) return;
    this.bones.metaVersion = a.metaVersion;
    this.restFoot.to = this.restFoot.from = 0;
    this.restFoot.p = 1;
    this.resetFooting();
    const hip = a.normalizedBone('rightUpperLeg'), foot = a.normalizedBone('rightFoot');
    const scale = a.scene.getWorldScale(tmpA).y || 1;
    this.size = hip && foot ? THREE.MathUtils.clamp(hip.getWorldPosition(tmpA).distanceTo(foot.getWorldPosition(tmpB)) / scale / 0.6, 0.6, 1.8) : 1;
  }

  /** Feet back where the avatar's pose puts them, to settle into a way of standing again with steps. */
  private resetFooting() {
    this.feet = { right: footState(), left: footState() };
    const f = this.footing;
    f.queue = [];
    f.phase = 'none';
    f.next = 0.8;
    f.settled = false;
    f.name = 'open';
  }

  private apply(app: App, a: Avatar, dt: number, live: boolean, idle: boolean) {
    const d = this.driver;
    const faceTracked = app.streaming.vmcActive() || app.streaming.oscActive();
    const samples = this.actions.sample();
    const vrc = app.vrc instanceof VrcAnimator ? app.vrc : null;
    const player = app.player.active;
    // Motions and VRChat animations (dances, AFK) move the body on their own: what they pose is left to
    // them (arms, legs, poses), and only a little is added on top of the rest.
    const animated = player || !!vrc?.posesBody();
    const small = this.smallMove(dt, idle && this.fade > 0.9 && !animated && !this.actions.active && !d?.voice.speaking && !d?.thinking() && this.footing.phase === 'none');

    // ---- Face: mouth from the voice, the line's emotion, blinking, the actions' faces.
    const target = new Map<string, number>();
    const actionFace = new Map<string, number>();
    for (const s of samples) {
      if (!s.face) continue;
      for (const [k, v] of Object.entries(s.face)) actionFace.set(k, Math.max(actionFace.get(k) || 0, v * s.weight));
    }
    if (!faceTracked) {
      if (d) {
        const v = d.voice, ls = d.lipSync();
        // Vowel shapes from the voice, and the jaw opening with the volume (high voices read mostly as "i").
        for (const [k, name] of MOUTH) target.set(name, Math.min(1, v.vowels[k] * ls * (name === 'aa' ? 1 : 0.7)));
        target.set('aa', Math.min(1, Math.max(target.get('aa')!, v.level * 0.5 * ls)));
        if (d.emotions()) {
          // The emotion stays a moment after the line ends.
          const emotion = d.emotion();
          if (v.speaking && emotion !== 'neutral') this.emotionHold = 1.5;
          else this.emotionHold = Math.max(0, this.emotionHold - dt);
          for (const e of EMOTIONS) target.set(e, e === emotion && this.emotionHold > 0 ? 0.65 : 0);
        }
      }
      // A smile now and then (small moves).
      for (const [name, v] of Object.entries(small.face)) if (v > (target.get(name) || 0)) target.set(name, v);
      // No blinking while something keeps the eyes shut (an action's face, a big smile).
      let shut = 0;
      for (const [name, v] of actionFace) shut = Math.max(shut, v * (name === 'blink' ? 1 : FACES[name]?.eyes || 0));
      for (const [name, v] of target) shut = Math.max(shut, v * (FACES[name]?.eyes || 0));
      if (mate.blink && (idle || live)) target.set('blink', this.blinkWeight(dt) * (1 - Math.min(1, shut)));
    }
    this.layer.clear();
    const fadeFace = live ? 1 : this.fade;
    for (const [name, w] of target) {
      const prev = this.weights.get(name) ?? 0;
      const rate = name === 'blink' || MOUTH.some(([, n]) => n === name) ? 1 : Math.min(1, dt * 4);
      const v = (prev + (w - prev) * rate) * fadeFace;
      this.weights.set(name, v);
      if (v >= 0.005) for (const [key, s] of this.keysFor(a, name)) this.layer.set(key, Math.max(this.layer.get(key) || 0, v * s));
    }
    if (!faceTracked) {
      for (const [name, v] of actionFace) {
        if (v >= 0.005) for (const [key, s] of this.keysFor(a, name)) this.layer.set(key, Math.max(this.layer.get(key) || 0, v * s));
      }
    }
    if (this.layer.size) a.setLayer(LAYER, this.layer); else a.clearLayer(LAYER);

    // ---- Body. Tracking moves it itself.
    const st = app.streaming;
    if (st.headTracked || (st.vmcActive() && st.bonesCount > 0)) { this.bones.restore(); this.resetEyes(); return; }
    const posed = (bone: string) => player || !!vrc?.posesBone(bone);
    const h = a.humanoid;
    const node = (b: string) => h?.getNormalizedBoneNode(b as VRMHumanBoneName) || null;
    // Handing the body over to an animation and back is eased, so the arms do not jump when a dance
    // starts or ends.
    const ease = Math.min(1, dt * 5);
    this.still += ((animated ? 0 : 1) - this.still) * ease;
    for (const bone of ARM_BONES) {
      const v = this.free.get(bone) ?? 1;
      this.free.set(bone, v + ((posed(bone) ? 0 : 1) - v) * ease);
    }
    const freeOf = (bone: string) => (ARM_BONES.has(bone) ? this.free.get(bone)! : posed(bone) ? 0 : 1);
    /** A frame at a weight; arms and hands may have their own (they follow the body a moment later). */
    const frame = (f: Frame, weight: number, arms = weight, hands = arms) => {
      if (Math.max(weight, arms, hands) <= 0.001) return;
      for (const [bone, m] of Object.entries(f) as [string, BoneMove][]) {
        // Fingers that a hand gesture, tracking or a motion poses are left to it.
        const finger = FINGER.exec(bone);
        if (finger && this.fingersBusy(app, finger[1] as 'left' | 'right')) continue;
        const own = finger || HAND_BONES.has(bone) ? hands : ARM_BONES.has(bone) ? arms : weight;
        const w = m.mode === 'pose' || ARM_BONES.has(bone) || LEG_BONES.has(bone) ? own * freeOf(bone) : own;
        const n = w > 0.001 ? node(bone) : null;
        if (n) this.bones.move(n, m, w);
      }
    };
    const k = this.fade * mate.intensity;
    /** Only a little of the idle motion on top of an animation */
    const onTop = 0.35 + 0.65 * this.still;

    // Standing at ease: arms down (another stance now and then), relaxed fingers, weight on one leg.
    const armsBusy = Math.max(0, ...samples.map((s) => s.armsWeight));
    if (mate.restPose && this.fade > 0.001) {
      this.updateStance(dt, idle && !animated && !this.actions.active);
      frame(SIDE, this.fade);
      const sk = smooth(this.stanceK);
      if (this.prevStance !== 'side') frame(STANCES[this.prevStance], this.fade * (1 - armsBusy));
      if (this.stance !== 'side') frame(STANCES[this.stance], this.fade * (1 - armsBusy) * sk);
      else if (this.prevStance !== 'side') frame(SIDE, this.fade * (1 - armsBusy) * sk);
      this.fingers(app, a, this.fade);
      this.swayArms(a, k * this.still * (1 - armsBusy), posed);
    }
    // The lower body: where the feet stand before anything moves (legs left to animations and tracking).
    const legsFree = this.still > 0.01 && ![...LEG_BONES].some((b) => posed(b));
    if (legsFree) this.rig.plant(a);
    const full = !live && mate.fullBody !== false;
    const footFree = full && idle && !animated && !this.actions.active && legsFree;
    this.planFooting(dt, footFree);
    const idleWeight = this.shiftWeight(dt, footFree);

    // Breathing: chest up and shoulders a little up on the way in (quicker than out).
    if (mate.breathing) {
      const b = this.breath;
      b.p += dt / b.period;
      if (b.p >= 1) {
        b.p -= 1;
        // A sigh (deeper and slower) once after an action, then the usual breathing.
        if (b.sigh === 1) { b.sigh = 2; b.period = 5.6; } else { b.sigh = 0; b.period = rand(3.6, 4.8); }
      }
      const inhale = b.p < 0.4 ? smooth(b.p / 0.4) : 1 - smooth((b.p - 0.4) / 0.6);
      const kb = k * onTop * inhale * DEG * (b.sigh === 2 ? 1.9 : 1);
      const chest = node('upperChest') || node('chest');
      if (chest) this.bones.offset(chest, -1.4 * kb, 0, 0);
      const spine = node('spine');
      if (spine) this.bones.offset(spine, 0.4 * kb, 0, 0);
      const rs = node('rightShoulder'), ls = node('leftShoulder');
      if (rs && !posed('rightShoulder')) this.bones.offset(rs, 0, 0, -1.1 * kb);
      if (ls && !posed('leftShoulder')) this.bones.offset(ls, 0, 0, 1.1 * kb);
      const head = node('head');
      if (head) this.bones.offset(head, 0.6 * kb, 0, 0);
    }

    // Reaction gestures and actions.
    if (d) this.thinkPose(dt, d.thinking() && d.gestures());
    for (const s of samples) frame(s.frame, s.weight, s.limbs, s.hands);
    if (idle && this.fade > 0.9) this.autoActions(dt, live, animated);

    // Small moves: a head tilt, a nod, a shrug, rocking from side to side.
    const ks = k * onTop * DEG;
    if (ks > 0.0001 && (small.roll || small.pitch || small.chestRoll || small.shoulders)) {
      const sh = node('head'), sn = node('neck'), sc = node('upperChest') || node('chest'), sp = node('spine');
      if (sh) this.bones.offset(sh, small.pitch * 0.7 * ks, 0, small.roll * 0.7 * ks);
      if (sn) this.bones.offset(sn, small.pitch * 0.3 * ks, 0, small.roll * 0.3 * ks);
      if (sc) this.bones.offset(sc, 0, 0, small.chestRoll * 0.6 * ks);
      if (sp) this.bones.offset(sp, 0, 0, small.chestRoll * 0.4 * ks);
      const rs = node('rightShoulder'), ls = node('leftShoulder');
      if (rs && !posed('rightShoulder')) this.bones.offset(rs, 0, 0, -small.shoulders * ks);
      if (ls && !posed('leftShoulder')) this.bones.offset(ls, 0, 0, small.shoulders * ks);
    }

    // The lower body: the weight from leg to leg, the motions' hips and feet, the balance for the upper
    // body's lean, then the legs solved so the feet stay where they stand.
    this.weightNow = 0;
    if (legsFree) {
      const body = this.body.reset();
      for (const s of samples) body.add(s.body, s.weight);
      body.add(small.body, k * small.amount);
      // Balance: as the upper body leans forward the hips go back, and sideways the other way.
      const lean = this.lean(samples, small, k);
      body.z -= 0.13 * Math.sin(lean.pitch * DEG);
      body.x += 0.13 * Math.sin(lean.roll * DEG);
      // Soft knees, and a little sway: nobody stands quite still.
      body.bob += 3 * k;
      body.x += 0.004 * noise(this.t * 0.11, 7) * k * mate.intensity;
      body.z += 0.004 * noise(this.t * 0.09, 8) * k * mate.intensity;
      // While the broadcast runs (or without the whole-body switch), the lower body is taken down and the
      // motions' steps left out (eased, so nothing jumps when it starts or ends).
      this.fullK += ((full ? 1 : 0) - this.fullK) * Math.min(1, dt * 1.5);
      body.scale(0.35 + 0.65 * this.fullK, this.fullK);
      // The way of standing (feet apart, one forward, …) and the resting foot stay either way.
      body.add(this.footingKeys(dt), k);
      body.add(this.restFootKeys(dt, footFree), k);
      body.width = this.footWidth * k;
      const w = body.weight(idleWeight * k) * this.still * (0.6 + 0.4 * this.fullK);
      if (this.rig.apply(a, this.bones, body, w)) {
        this.weightNow = w;
        // The upper body against the hips' tilt: the shoulders go the other way (contrapposto).
        const spine = node('spine'), chest = node('chest'), head = node('head');
        if (spine) this.bones.offset(spine, 0, 0, 3.0 * w * DEG);
        if (chest) this.bones.offset(chest, 0, 0, 0.5 * w * DEG);
        if (head) this.bones.offset(head, 0, 0, -0.9 * w * DEG);
      }
    }

    // Head and eyes: looking at the viewer and around, a little sway, nodding with the voice.
    const cursor = general.cursorGaze;
    const kh = this.fade * onTop;
    const gazeOverride = this.gazeOverride(samples);
    if (!cursor && (kh > 0.001 || gazeOverride)) this.updateLook(dt, app, a, live, !!d?.voice.speaking, gazeOverride);
    this.nod += ((d?.voice.level || 0) * 0.07 - this.nod) * Math.min(1, dt * 6);
    const t = this.t;
    const swayYaw = 0.014 * noise(t * 0.23, 1) * mate.intensity;
    const swayPitch = (0.01 * noise(t * 0.19, 2) * mate.intensity) + this.nod * (0.6 + 0.4 * Math.sin(t * 7));
    const swayRoll = 0.02 * noise(t * 0.13, 3) * mate.intensity;
    const gw = gazeOverride ? Math.max(kh, gazeOverride.weight) : kh;
    const yaw = (cursor ? 0 : this.headYaw.x) * gw + swayYaw * kh;
    const pitch = (cursor ? 0 : this.headPitch.x) * gw + swayPitch * kh;
    const roll = swayRoll * kh;
    const head = node('head'), neck = node('neck'), upper = node('upperChest') || node('chest');
    if (head) this.bones.offset(head, pitch * 0.6, yaw * 0.6, roll);
    if (neck) this.bones.offset(neck, pitch * 0.4, yaw * 0.3, roll * 0.3);
    if (upper) this.bones.offset(upper, 0, yaw * 0.1, 0);

    // Eyes lead, the head follows: what the head has not turned yet the eyes do.
    const la = a.vrm?.lookAt;
    if (la && !cursor && !st.drivesGaze && !player && gw > 0.001) {
      this.droveEyes = true;
      la.target = null;
      la.yaw = THREE.MathUtils.radToDeg(this.eye.yaw * gw - yaw) * 1.4;
      la.pitch = -THREE.MathUtils.radToDeg(this.eye.pitch * gw - pitch) * 1.2;
    } else {
      this.resetEyes();
    }
  }

  /** Takes everything off the avatar at once (switched off). */
  reset() {
    this.bones.restore();
    this.resetEyes();
    this.avatar?.clearLayer(LAYER);
    this.weights.clear();
    this.fade = 0;
    this.applied = false;
    this.headYaw.reset();
    this.headPitch.reset();
    this.weight.reset();
    this.small.kind = null;
    this.small.fade = 0;
    this.resetFooting();
  }

  // ---- Standing --------------------------------------------------------------------------------------

  private updateStance(dt: number, free: boolean) {
    this.stanceK = Math.min(1, this.stanceK + dt / 1.6);
    if (this.stanceK >= 1) this.prevStance = this.stance;
    // Off: no changes on its own (a stance picked in the panel stays).
    if (!mate.poses || !free) return;
    this.nextStance -= dt;
    if (this.nextStance > 0) return;
    // Mostly arms at the sides; now and then hands in front or behind the back for a while.
    const next: Stance = this.stance !== 'side' ? 'side' : Math.random() < 0.5 ? 'front' : 'back';
    this.setStance(next);
    this.nextStance = next === 'side' ? rand(40, 90) : rand(20, 45);
  }

  /** A hand gesture, finger tracking or a motion poses the fingers of that hand. */
  private fingersBusy(app: App, side: 'left' | 'right') {
    return (side === 'left' ? app.gestures.left : app.gestures.right) !== 0 || app.streaming.fingersTracked[side] || app.player.active;
  }

  /** Relaxed fingers, unless a hand gesture, tracking or the avatar's own animation poses them. */
  private fingers(app: App, a: Avatar, weight: number) {
    const vrc = app.vrc instanceof VrcAnimator ? app.vrc : null;
    for (const side of ['left', 'right'] as const) {
      if (this.fingersBusy(app, side)) continue;
      const s = side === 'right' ? 1 : -1;
      const chains = fingerBones(side);
      for (let f = 0; f < 5; f++) {
        for (let j = 0; j < 3; j++) {
          const bone = chains[f][j];
          if (vrc?.posesBone(bone)) continue;
          const n = a.normalizedBone(bone);
          if (!n) continue;
          // The thumb folds about x, the fingers curl about z (toward the palm).
          const m: BoneMove = f === 0 ? pose(['x', RELAXED[0][j]]) : pose(['z', s * RELAXED[f][j]]);
          this.bones.move(n, m, weight);
        }
      }
    }
  }

  /**
   * Weight from one leg to the other now and then (free: the idle motion runs on its own). The rig moves
   * the hips over that leg; the free foot may go a little forward meanwhile, and comes back first.
   */
  private shiftWeight(dt: number, free: boolean) {
    const r = this.restFoot;
    const stepping = this.footing.phase !== 'none';
    // Switched off: the weight eases back to both legs (it still moves for a step).
    if (!mate.weightShift && !stepping) this.weightTo = 0;
    this.nextWeight -= dt;
    if (this.nextWeight <= 0 && !stepping && mate.weightShift) {
      if (r.to > 0) {
        // Bring the resting foot back before the weight goes onto it.
        this.stepRestFoot(0);
        this.nextWeight = 0.7;
      } else {
        this.weightTo = this.weightTo > 0 ? -rand(0.6, 1) : rand(0.6, 1);
        if (Math.random() < 0.2) this.weightTo = rand(-0.25, 0.25);
        this.nextWeight = rand(7, 16);
        r.decided = false;
      }
    }
    // The weight goes over more quickly before a foot steps.
    const w = this.weight.step(this.weightTo, stepping ? 3.2 : 1.3, dt);
    // Settled on one leg: now and then the free foot goes a little forward (not with one forward already).
    if (free && !stepping && !r.decided && this.nextWeight > 2 && this.footing.name !== 'stagger' &&
      Math.abs(this.weightTo) > 0.6 && Math.abs(w - this.weightTo) < 0.08 && r.p >= 1) {
      r.decided = true;
      if (Math.random() < 0.35) { r.side = this.weightTo > 0 ? 'left' : 'right'; this.stepRestFoot(1); }
    }
    return w;
  }

  /**
   * Now and then another way of standing (free: idle on its own, the whole body): each foot that has to
   * move does so in turn, the weight going onto the other leg first. The first one settles the avatar in.
   */
  private planFooting(dt: number, free: boolean) {
    const f = this.footing;
    if (f.phase === 'none') {
      const r = this.restFoot;
      if (!free || r.to > 0 || r.p < 1) return;
      f.next -= dt;
      if (f.next > 0) return;
      f.next = rand(30, 70);
      let name: Footing = 'open';
      if (f.settled) {
        // Changing on its own only with "change the pose now and then" on.
        if (mate.poses === false) return;
        const pool = (Object.keys(FOOTINGS) as Footing[]).filter((n) => n !== f.name);
        let x = Math.random() * pool.reduce((sum, n) => sum + FOOTINGS[n].chance, 0);
        name = pool.find((n) => (x -= FOOTINGS[n].chance) <= 0) || 'open';
      }
      f.settled = true;
      const [right, left] = FOOTINGS[name].feet;
      const swap = name === 'stagger' && Math.random() < 0.5;
      f.to = swap ? { right: { ...left }, left: { ...right } } : { right, left };
      f.name = name;
      // The feet that have to move, the one with less weight on it first.
      const w = this.weight.x;
      f.queue = (['right', 'left'] as const).filter((side) => placeDiff(this.feet[side].to, f.to[side]) > 0.008)
        .sort((a, b) => (a === 'right' ? w : -w) - (b === 'right' ? w : -w));
      if (f.queue.length) f.phase = 'shift';
      return;
    }
    const side = f.queue[0];
    if (f.phase === 'shift') {
      // Wait while something else plays; then onto the other leg, and the foot steps once it carries no
      // weight (the weight as shown, small moves and all).
      if (!free) return;
      this.weightTo = side === 'right' ? -0.8 : 0.8;
      this.nextWeight = Math.max(this.nextWeight, 2);
      if (Math.abs(this.weightNow - this.weightTo) < 0.2) {
        this.stepFoot(side, f.to[side]);
        f.phase = 'step';
      }
    } else if (this.feet[side].p >= 1) {
      f.queue.shift();
      if (f.queue.length) f.phase = 'shift';
      else {
        f.phase = 'none';
        this.weightTo = mate.weightShift ? rand(-0.5, 0.5) : 0;
        this.nextWeight = rand(4, 10);
      }
    }
  }

  /** A foot steps to a new place (from where it is, also when a step is cut short). */
  private stepFoot(side: 'right' | 'left', to: Place) {
    const f = this.feet[side];
    f.from = lerpPlace(f.from, f.to, smooth(f.p));
    f.to = to;
    f.p = 0;
    f.liftFrom = f.lift;
  }

  /** The way of standing as body keys: each foot where it stands, lifted on the way while it steps. */
  private footingKeys(dt: number): BodyKeys {
    const keys: BodyKeys = {};
    let width = 0;
    for (const side of ['right', 'left'] as const) {
      const f = this.feet[side];
      f.p = Math.min(1, f.p + dt / 0.5);
      const e = smooth(f.p);
      const at = lerpPlace(f.from, f.to, e);
      // Up and down gently; a short step stays low.
      const reach = Math.min(1, Math.hypot(f.to.out - f.from.out, f.to.fwd - f.from.fwd) / 0.03 + Math.abs(f.to.yaw - f.from.yaw) / 15);
      f.lift = f.liftFrom * (1 - e) + reach * bump(f.p, 0, 1);
      const s = side === 'right' ? -1 : 1;
      keys[side] = { x: s * at.out * this.size, z: at.fwd * this.size, yaw: s * at.yaw, y: 0.022 * f.lift * this.size, heel: 8 * f.lift };
      width += at.out * this.size / 2;
    }
    this.footWidth = width;
    return keys;
  }

  private stepRestFoot(to: number) {
    const r = this.restFoot;
    if (r.to === to) return;
    r.from = r.from + (r.to - r.from) * smooth(r.p);
    r.to = to;
    r.p = 0;
    // A step cut short in the air: the foot comes down from where it is.
    r.liftFrom = r.lift;
  }

  /** The resting foot as body keys: a small step forward and out, the toes turned out (free: may stay out). */
  private restFootKeys(dt: number, free: boolean): BodyKeys | null {
    const r = this.restFoot;
    if (!free && r.to > 0) this.stepRestFoot(0);
    r.p = Math.min(1, r.p + dt / 0.6);
    const k = r.from + (r.to - r.from) * smooth(r.p);
    // The foot comes up and goes down gently (no jerk at either end); a shorter step, a lower one.
    r.lift = r.liftFrom * (1 - smooth(r.p)) + Math.abs(r.to - r.from) * bump(r.p, 0, 1);
    if (k < 0.001 && r.p >= 1) return null;
    const out = r.side === 'right' ? -1 : 1;
    return { [r.side]: { x: 0.025 * out * k, z: 0.07 * k, y: 0.025 * r.lift, yaw: 10 * out * k, heel: 6 * r.lift } };
  }

  /** How far the motions lean the upper body forward and sideways (degrees, for the balance). */
  private lean(samples: ActionSample[], small: SmallOut, k: number) {
    let pitch = small.pitch * 0.3 * k, roll = small.chestRoll * k;
    for (const s of samples) {
      for (const [bone, f] of LEAN_BONES) {
        const m = s.frame[bone];
        if (!m || m.mode !== 'add') continue;
        const w = s.weight * (m.w ?? 1) * f;
        for (const [ax, deg] of m.steps) {
          if (ax === 'x') pitch += deg * w;
          else if (ax === 'z') roll += deg * w;
        }
      }
    }
    return { pitch, roll };
  }

  /**
   * Arms hanging loose: swaying a little on their own, elbows soft, and kept hanging straight down while
   * the body tilts with the weight shift.
   */
  private swayArms(a: Avatar, k: number, posed: (bone: string) => boolean) {
    if (k < 0.001) return;
    const t = this.t;
    // The chest tilts by about 1.3° per unit of weight shift (shiftWeight); the arms turn back by that.
    const plumb = -1.3 * this.weightNow;
    for (const [side, seed, s] of [['right', 11, 1], ['left', 23, -1]] as const) {
      const ua = a.normalizedBone(`${side}UpperArm`), la = a.normalizedBone(`${side}LowerArm`), hand = a.normalizedBone(`${side}Hand`);
      if (ua && !posed(`${side}UpperArm`)) this.bones.offset(ua, 0, 1.6 * noise(t * 0.21, seed) * DEG * k, (0.8 * noise(t * 0.17, seed + 1) + plumb) * DEG * k);
      if (la && !posed(`${side}LowerArm`)) this.bones.offset(la, 0, s * (2 + 2.5 * noise(t * 0.25, seed + 2)) * DEG * k, 0);
      if (hand && !posed(`${side}Hand`)) this.bones.offset(hand, 0, 0, 3 * noise(t * 0.3, seed + 3) * DEG * k);
    }
  }

  // ---- Small moves -------------------------------------------------------------------------------------

  /**
   * Now and then while idle (free): a smile at the viewer, a head tilt, a little nod, up on the toes,
   * rocking from side to side, a shrug. Eased out when something else starts.
   */
  private smallMove(dt: number, free: boolean): SmallOut {
    const s = this.small;
    const out: SmallOut = { face: {}, roll: 0, pitch: 0, chestRoll: 0, shoulders: 0, body: {}, amount: 0 };
    s.fade += ((free ? 1 : 0) - s.fade) * Math.min(1, dt * 3);
    if (s.kind) {
      s.t += dt;
      if (s.t >= s.length) { s.kind = null; s.next = rand(4, 10); }
    } else if (free && mate.smallMoves !== false) {
      s.next -= dt;
      if (s.next <= 0) this.startSmall(s.smileSoon ? 'smile' : this.pickSmall());
    }
    if (!s.kind || s.fade < 0.001) return out;
    const t = s.t, f = s.fade, side = s.side;
    const env = Math.min(smooth(t / 0.7), smooth((s.length - t) / 0.7)) * f;
    switch (s.kind) {
      case 'smile':
        out.face.happy = 0.4 * env;
        out.face.smileMouth = 0.6 * env;
        out.face.blush = 0.35 * env;
        out.roll = 6 * side * env;
        out.pitch = 3 * env;
        out.body = { weight: -0.35 * side };
        out.amount = env;
        break;
      case 'tilt': {
        const pop = Math.min(back(t / 0.4), smooth((s.length - t) / 0.6)) * f;
        out.roll = 12 * side * pop;
        out.chestRoll = -3 * side * pop;
        // The hips go the other way: the whole body in a curve.
        out.body = { weight: -0.55 * side };
        out.amount = pop;
        out.face.happy = 0.15 * env;
        out.face.smileMouth = 0.35 * env;
        break;
      }
      case 'nod': {
        const n = t < 0.2 ? smooth(t / 0.2) : 1 - smooth((t - 0.2) / 0.4);
        out.pitch = 9 * n * f;
        out.body = { bob: 4 * n };
        out.amount = f;
        out.face.smileMouth = 0.4 * env;
        break;
      }
      case 'toes':
        out.body = { rise: 0.8 * (bump(t, 0.05, 0.6) + bump(t, 0.65, 1.25)), bob: 3 * (bump(t, 0.5, 0.75) + bump(t, 1.1, 1.4)) };
        out.amount = f;
        out.face.smileMouth = 0.4 * env;
        break;
      case 'rock': {
        const r = Math.sin(t * Math.PI * 2 * 0.5);
        out.chestRoll = 2.5 * r * env;
        out.roll = -4.5 * Math.sin(t * Math.PI * 2 * 0.5 - 0.6) * env;
        // Rocking from leg to leg, the knees giving a little as the weight crosses over.
        out.body = { weight: 0.75 * r, bob: 3 * (1 - Math.abs(r)) };
        out.amount = env;
        out.face.happy = 0.15 * env;
        out.face.smileMouth = 0.35 * env;
        break;
      }
      case 'shrug': {
        const b = bump(t, 0.05, 0.6);
        out.shoulders = 10 * b * f;
        out.pitch = -3 * b * f;
        out.roll = 3 * side * b * f;
        out.body = { bob: 2.5 * b };
        out.amount = f;
        out.face.happy = 0.3 * env;
        out.face.smileMouth = 0.5 * env;
        break;
      }
      case 'pop': {
        // Weight onto one leg and the other heel up, the knee bent forward: a little foot pop.
        const foot = side > 0 ? 'right' : 'left';
        out.body = { weight: -0.7 * side, [foot]: { heel: 28 } };
        out.amount = env;
        out.roll = -3 * side * env;
        out.face.smileMouth = 0.45 * env;
        break;
      }
    }
    return out;
  }

  private pickSmall(): SmallMove {
    const pool = SMALL_MOVES.filter(([k]) => k !== this.small.last);
    let r = Math.random() * pool.reduce((sum, p) => sum + p[1], 0);
    for (const [k, w] of pool) { r -= w; if (r <= 0) return k; }
    return pool[0][0];
  }

  private startSmall(kind: SmallMove) {
    const s = this.small;
    const [, , lo, hi] = SMALL_MOVES.find(([k]) => k === kind)!;
    s.kind = kind;
    s.last = kind;
    s.t = 0;
    s.length = rand(lo, hi);
    s.side = Math.random() < 0.5 ? -1 : 1;
    s.smileSoon = false;
  }

  // ---- Gaze --------------------------------------------------------------------------------------------

  /** Direction of the camera from the head (the viewer), or null when it is far to the side or behind. */
  private viewer(app: App, a: Avatar): { yaw: number; pitch: number } | null {
    if (!mate.lookAtViewer) return null;
    const head = a.normalizedBone('head');
    if (!head) return null;
    const root = app.stage.avatarRoot;
    root.worldToLocal(app.stage.rig.camera.getWorldPosition(tmpA));
    root.worldToLocal(head.getWorldPosition(tmpB));
    tmpA.sub(tmpB);
    const yaw = Math.atan2(tmpA.x, tmpA.z);
    if (Math.abs(yaw) > 1.1) return null;
    const pitch = -Math.atan2(tmpA.y, Math.hypot(tmpA.x, tmpA.z));
    return { yaw: THREE.MathUtils.clamp(yaw, -0.6, 0.6), pitch: THREE.MathUtils.clamp(pitch, -0.35, 0.35) };
  }

  private gazeOverride(samples: ActionSample[]) {
    let best: { yaw: number; pitch: number; weight: number } | null = null;
    for (const s of samples) {
      const w = s.gaze ? s.weight * s.gaze[2] : 0;
      if (w <= 0.001 || (best && best.weight >= w)) continue;
      best = { yaw: s.gaze![0] * DEG, pitch: s.gaze![1] * DEG, weight: w };
    }
    return best;
  }

  private updateLook(dt: number, app: App, a: Avatar, live: boolean, speaking: boolean, override: { yaw: number; pitch: number; weight: number } | null) {
    const l = this.look;
    const viewer = this.viewer(app, a);
    l.next -= dt;
    if (l.next <= 0) {
      // Mostly at the viewer; now and then a glance aside or down (rarely while talking).
      const away = !mate.lookAround ? 0 : speaking ? 0.06 : live ? 0.3 : 0.45;
      const fromYaw = l.onViewer ? (viewer?.yaw ?? 0) + l.offYaw : l.offYaw;
      const fromPitch = l.onViewer ? (viewer?.pitch ?? 0) + l.offPitch : l.offPitch;
      if (Math.random() < away) {
        l.onViewer = false;
        if (Math.random() < 0.7) { l.offYaw = rand(-0.45, 0.45); l.offPitch = rand(-0.06, 0.12); } else { l.offYaw = rand(-0.2, 0.2); l.offPitch = rand(0.18, 0.32); }
        l.next = rand(0.9, 3);
      } else {
        // Back at the viewer after looking away: often with a smile.
        if (!l.onViewer && !speaking && Math.random() < 0.4) { this.small.smileSoon = true; this.small.next = Math.min(this.small.next, 0.5); }
        l.onViewer = true;
        l.offYaw = rand(-0.03, 0.03);
        l.offPitch = rand(-0.02, 0.02);
        l.next = rand(2.5, 7);
      }
      const toYaw = l.onViewer ? (viewer?.yaw ?? 0) + l.offYaw : l.offYaw;
      const toPitch = l.onViewer ? (viewer?.pitch ?? 0) + l.offPitch : l.offPitch;
      // A blink often goes with a big look away.
      if (Math.hypot(toYaw - fromYaw, toPitch - fromPitch) > 0.25 && Math.random() < 0.5 && this.blink.phase < 0) this.blink.next = 0.05;
    }
    let yaw = l.onViewer ? (viewer?.yaw ?? 0) + l.offYaw : l.offYaw;
    let pitch = l.onViewer ? (viewer?.pitch ?? 0) + l.offPitch : l.offPitch;
    if (override) {
      yaw += (override.yaw - yaw) * override.weight;
      pitch += (override.pitch - pitch) * override.weight;
    }
    // Tiny eye jumps now and then (saccades), the eyes only.
    const m = this.micro;
    m.next -= dt;
    if (m.next <= 0) {
      const big = Math.random() < 0.2;
      m.yaw = rand(-1, 1) * (big ? 0.03 : 0.012);
      m.pitch = rand(-1, 1) * (big ? 0.02 : 0.008);
      m.next = rand(0.35, 1.6);
    }
    const ke = 1 - Math.exp(-dt * 30);
    this.eye.yaw += (yaw + m.yaw - this.eye.yaw) * ke;
    this.eye.pitch += (pitch + m.pitch - this.eye.pitch) * ke;
    // The head turns only part of the way, a moment later.
    this.headYaw.step(yaw * 0.62, 4.5, dt);
    this.headPitch.step(pitch * 0.5, 4, dt);
  }

  // ---- Actions -----------------------------------------------------------------------------------------

  /** Now and then something on its own: not while talking, thinking or while an animation plays. */
  private autoActions(dt: number, live: boolean, animated: boolean) {
    const d = this.driver;
    if (mate.actions === 'off' || this.actions.active || animated) return;
    if (live && (!d || !d.gestures() || d.voice.speaking || d.thinking())) return;
    this.nextAction -= dt;
    if (this.nextAction > 0) return;
    const [lo, hi] = ACTION_GAPS[mate.actions];
    this.nextAction = rand(lo, hi);
    const pool = [...IDLE_ACTIONS, ...GESTURES]
      .map((name) => ({ name, info: actionInfo(name) }))
      .filter(({ name, info }) => info.idle > 0 && (!live || info.onAir) && this.actions.ready(name) && !this.lastActions.includes(name));
    let r = Math.random() * pool.reduce((s, p) => s + p.info.idle, 0);
    for (const p of pool) {
      r -= p.info.idle;
      if (r > 0) continue;
      this.actions.play(p.name);
      this.lastActions = [p.name, ...this.lastActions].slice(0, 2);
      return;
    }
  }

  /** The thinking pose while the LLM works on an answer (after a moment, so quick answers do not flicker). */
  private thinkPose(dt: number, thinking: boolean) {
    this.thinkingFor = thinking ? this.thinkingFor + dt : 0;
    if (this.thinkingFor > 0.6 && !this.actions.active) {
      this.actions.play('think', true);
      this.thinkHeld = true;
    } else if (!thinking && this.thinkHeld) {
      this.actions.release('think');
      this.thinkHeld = false;
    }
  }

  // ---- Face --------------------------------------------------------------------------------------------

  private keysFor(a: Avatar, name: string) {
    let k = this.keys.get(name);
    if (!k) {
      const face = FACES[name];
      k = face ? this.firstFace(a, face.candidates) : a.resolveExpression(name).map((key): [string, number] => [key, 1]);
      this.keys.set(name, k);
    }
    return k;
  }

  /** The first candidate the avatar has (for several shapes together: all of them). */
  private firstFace(a: Avatar, candidates: FaceCandidate[]): [string, number][] {
    for (const c of candidates) {
      const parts: [string, number][] = typeof c === 'string' ? [[c, 1]] : c;
      const found = parts.map(([n, s]) => a.resolveShape(n).map((key): [string, number] => [key, s]));
      if (found.every((f) => f.length)) return found.flat();
    }
    return [];
  }

  private blinkWeight(dt: number) {
    const b = this.blink;
    if (b.phase < 0) {
      b.next -= dt;
      if (b.next <= 0) b.phase = 0;
      return 0;
    }
    b.phase += dt;
    const p = b.phase;
    // Closes quickly (0.07 s), stays shut a moment, opens more slowly (0.13 s); sometimes twice.
    const w = p < 0.07 ? smooth(p / 0.07) : p < 0.1 ? 1 : p < 0.23 ? 1 - smooth((p - 0.1) / 0.13) : 0;
    if (p >= 0.23) {
      b.phase = -1;
      b.next = Math.random() < 0.12 ? 0.12 : Math.min(8, 1.4 + -Math.log(1 - Math.random()) * 2.6);
    }
    return w;
  }

  private resetEyes() {
    const la = this.avatar?.vrm?.lookAt;
    if (la && this.droveEyes && !general.cursorGaze) { la.yaw = 0; la.pitch = 0; }
    this.droveEyes = false;
  }
}
