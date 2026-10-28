// VRChat avatar animator for sidecar version 2 (<name>.vavmeta.json from unity-exporter 0.2+).
// Runs the avatar's Gesture / Action / FX playable layers the way VRChat does: animator parameters with
// VRChat's built-ins, state machines (Any State / Entry / Exit, exit time, crossfades, triggers), blend
// trees (1D, 2D, Direct), Write Defaults, and the VRC State Behaviours (Avatar Parameter Driver, Playable
// and Animator Layer Control, Tracking Control). The result is applied to the avatar: blendshapes, object
// and renderer toggles, material swaps (loaded from the VRM on first use), generic transforms and the
// humanoid poses the exporter baked per avatar (Action layer, Gesture-layer fingers). Format: docs/vavmeta.md.
import * as THREE from 'three';
import type { Avatar } from './avatar';
import type { VavMeta, VrcParameter } from './vrcMeta';
import { AvatarPaths } from './vrcPaths';

// ---------------------------------------------------------------------------
// Sidecar v2 data

export interface V2Transition { to?: number; toM?: number; exit?: boolean; c: [string, number, number][]; et?: number; d?: number; fixed?: boolean; o?: number; self?: boolean }
export interface V2Machine { name: string; parent: number; default: number; entry?: V2Transition[]; any?: V2Transition[]; exits?: { from: number; t: V2Transition[] }[] }
export interface V2Tree { type: '1d' | '2d' | 'direct'; p?: string; p2?: string; children: { m: V2Motion; th?: number; pos?: [number, number]; dp?: string; ts?: number }[] }
export type V2Motion = null | { clip: number } | { tree: V2Tree };
export interface V2DriverOp { t: string; n: string; s?: string; v: number; min: number; max: number; ch: number; range?: [number, number, number, number] }
export type V2Behaviour =
  | { type: 'driver'; local: boolean; ops: V2DriverOp[] }
  | { type: 'playable'; layer: string; goal: number; dur: number }
  | { type: 'layer'; playable: string; layer: number; goal: number; dur: number }
  | { type: 'tracking'; [part: string]: string }
  | { type: 'locomotion'; disable: boolean };
export interface V2State {
  name: string; m: number; motion: V2Motion; speed?: number; speedParam?: string; timeParam?: string;
  cycleOffset?: number; cycleOffsetParam?: string; wd: boolean; behaviours?: V2Behaviour[]; transitions?: V2Transition[];
}
export interface V2Layer { name: string; weight: number; additive?: boolean; mask?: { humanoid: string[]; transforms?: string[] }; synced?: number; machines: V2Machine[]; states: V2State[] }
export interface V2Playable { type: string; layers: V2Layer[] }
export interface V2Curve { p: string; k: string; n?: string; c?: string; v: number[] }
export interface V2Humanoid { rate: number; frames: number; bones: string[]; rot: string; hips?: string }
export interface V2Clip { name: string; length: number; loop?: boolean; curves: V2Curve[]; materials?: { p: string; slot: number; v: number[] }[]; humanoid?: V2Humanoid }
export interface V2Meta extends VavMeta {
  icons?: string[];
  animator?: { parameters: VrcParameter[]; playables: V2Playable[] };
  clips?: V2Clip[];
  materials?: { index: number; name: string }[];
}

// ---------------------------------------------------------------------------

/** VRChat built-in parameters for a local desktop user (they override controller defaults). */
const BUILTIN: Record<string, number> = {
  IsLocal: 1, Grounded: 1, Upright: 1, TrackingType: 3, VRMode: 0, AFK: 0, Seated: 0, InStation: 0,
  MuteSelf: 0, Earmuffs: 0, Viseme: 0, Voice: 0, GestureLeft: 0, GestureRight: 0, GestureLeftWeight: 0,
  GestureRightWeight: 0, AngularY: 0, VelocityX: 0, VelocityY: 0, VelocityZ: 0, VelocityMagnitude: 0,
  IsAnimatorEnabled: 1, IsOnFriendsList: 0, AvatarVersion: 3, ScaleModified: 0, ScaleFactor: 1,
  ScaleFactorInverse: 1, EyeHeightAsMeters: 1.6, EyeHeightAsPercent: 0.5, PreviewMode: 0, VRCEmote: 0,
};

const BODY_PARTS: Record<string, string[]> = {
  Body: ['hips', 'spine', 'chest', 'upperChest'],
  Head: ['neck', 'head', 'leftEye', 'rightEye', 'jaw'],
  LeftLeg: ['leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes'],
  RightLeg: ['rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes'],
  LeftArm: ['leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand'],
  RightArm: ['rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand'],
};
for (const side of ['left', 'right']) {
  const list: string[] = [];
  for (const f of ['Thumb', 'Index', 'Middle', 'Ring', 'Little']) {
    for (const seg of f === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal']) list.push(`${side}${f}${seg}`);
  }
  BODY_PARTS[side === 'left' ? 'LeftFingers' : 'RightFingers'] = list;
}
const FINGER_SIDE = new Map<string, 'left' | 'right'>();
for (const b of BODY_PARTS.LeftFingers) FINGER_SIDE.set(b, 'left');
for (const b of BODY_PARTS.RightFingers) FINGER_SIDE.set(b, 'right');

const enum Kind { Shape, Active, Enabled, Mat, Pos, Rot, Euler, Scale, Param, Slot }
const KINDS: Record<string, Kind> = {
  shape: Kind.Shape, active: Kind.Active, enabled: Kind.Enabled, mat: Kind.Mat, pos: Kind.Pos,
  rot: Kind.Rot, euler: Kind.Euler, scale: Kind.Scale, param: Kind.Param,
};
const COMP: Record<string, number> = { x: 0, y: 1, z: 2, w: 3 };

interface Prop { kind: Kind; path: string; name: string; comp: number }
interface CurveRT { prop: number; keys: number[] }
interface SlotCurveRT { prop: number; keys: number[] }
interface HumanRT { rate: number; frames: number; bones: string[]; rot: Float32Array; hips: Float32Array | null }
interface ClipRT { name: string; length: number; loop: boolean; curves: CurveRT[]; slots: SlotCurveRT[]; human: HumanRT | null; props: number[]; dynamic: boolean }

/** Accumulated motion output: prop → [Σ w·v, Σ w]; slots keep the value with the highest weight. */
interface Acc { values: Map<number, [number, number]>; bones: Map<string, [THREE.Quaternion, number]>; hips: [THREE.Vector3, number] | null }

interface LayerRT {
  def: V2Layer;
  playable: PlayableRT;
  index: number;
  weight: number;
  weightTarget: number;
  weightRate: number;
  anyTransitions: V2Transition[];
  bound: number[];
  boneMask: Set<string> | null;
  cur: number;
  time: number;
  next: number;
  nextTime: number;
  trans: { elapsed: number; duration: number } | null;
  /** Last value this layer wrote per property (Write Defaults OFF states keep writing it). */
  held: Map<number, number>;
  humanOut: Map<string, [THREE.Quaternion, number]>;
  hipsOut: [THREE.Vector3, number] | null;
}

interface PlayableRT { type: string; weight: number; weightTarget: number; weightRate: number; layers: LayerRT[] }

/** A node with animated transform components (prop index per component, -1 when not animated). */
interface XfNode {
  node: THREE.Object3D;
  pos: number[]; rot: number[]; euler: number[]; scale: number[];
  p0: THREE.Vector3; q0: THREE.Quaternion; s0: THREE.Vector3;
  /** Rest rotation as Unity Euler degrees (applied Z, X, Y). */
  e0: [number, number, number];
  touched: boolean;
}

const qTmp = new THREE.Quaternion();
const qTmp2 = new THREE.Quaternion();
const eTmp = new THREE.Euler();

function evalCurve(k: number[], t: number): number {
  const n = k.length >> 2;
  if (n === 0) return 0;
  if (n === 1 || t <= k[0]) return k[1];
  const last = (n - 1) * 4;
  if (t >= k[last]) return k[last + 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (k[mid * 4] <= t) lo = mid; else hi = mid;
  }
  const a = lo * 4, b = hi * 4;
  const dt = k[b] - k[a];
  if (dt <= 0) return k[b + 1];
  const outSlope = k[a + 3], inSlope = k[b + 2];
  // Stepped keys (Unity's infinite tangents are written as ±1e9).
  if (Math.abs(outSlope) >= 1e8 || Math.abs(inSlope) >= 1e8) return k[a + 1];
  const s = (t - k[a]) / dt;
  const s2 = s * s, s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * k[a + 1] + (s3 - 2 * s2 + s) * dt * outSlope + (-2 * s3 + 3 * s2) * k[b + 1] + (s3 - s2) * dt * inSlope;
}

function decodeFloats(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

export interface AnimatorTick {
  /** Fingers driven by hand tracking keep their pose (Gesture-layer hand animations are skipped). */
  fingersTracked: { left: boolean; right: boolean };
}

export interface AvatarAnimation { clip: number; name: string; length: number; loop: boolean }

export class VrcAnimator {
  readonly meta: V2Meta;
  readonly avatar: Avatar;
  readonly paths: AvatarPaths;
  /** Expression parameters (bool / int / float) in menu order. */
  readonly parameters: VrcParameter[];
  /** Menu icons as data URLs (index from VrcControl.icon). */
  readonly icons: string[];
  readonly hasGestures = true;
  /** VRC Animator Tracking Control state per part ('tracking' | 'animation'). */
  readonly tracking: Record<string, string> = {};
  /** Called when the user changes a parameter. */
  onChange?: () => void;
  /** Called (at most once per frame) when parameters changed inside the animator (drivers, gestures). */
  onParamsChange?: () => void;

  private values = new Map<string, number>();
  private defaults = new Map<string, number>();
  private types = new Map<string, string>();
  private expressionNames = new Set<string>();
  private props: Prop[] = [];
  private propIndex = new Map<string, number>();
  private propDefault: number[] = [];
  private clips: ClipRT[] = [];
  private playables: PlayableRT[] = [];
  private stream: Float64Array = new Float64Array(0);
  private paramsDirty = false;

  // scene application
  private shapeProps: number[] = [];
  private visNodes: { node: THREE.Object3D; active: number; enabled: number; def: boolean }[] = [];
  private slotProps: { prop: number; node: THREE.Object3D | null; slot: number; applied: number }[] = [];
  private transformNodes: XfNode[] = [];
  private paramProps: number[] = [];
  private originalMaterials = new Map<THREE.Mesh, { material: THREE.Material | THREE.Material[]; renderOrder: number }>();
  private loadedMaterials = new Map<number, Promise<THREE.Material | null>>();
  private outlineMaterials = new Map<THREE.Material, THREE.Material>();
  private swapTokens = new Map<THREE.Mesh, number>();
  private boneBase = new Map<string, { written: THREE.Quaternion; base: THREE.Quaternion }>();
  private hipsBase: { written: THREE.Vector3; base: THREE.Vector3 } | null = null;

  constructor(avatar: Avatar, meta: V2Meta) {
    this.avatar = avatar;
    this.meta = meta;
    this.paths = new AvatarPaths(avatar);
    this.icons = meta.icons || [];
    for (const p of meta.animator?.parameters || []) this.declare(p);
    for (const p of meta.parameters || []) {
      this.expressionNames.add(p.name);
      if (!this.types.has(p.name)) this.declare(p);
      else this.defaults.set(p.name, Number(p.default) || 0);
    }
    for (const [name, v] of Object.entries(BUILTIN)) {
      if (!this.types.has(name)) this.types.set(name, 'float');
      this.defaults.set(name, v);
    }
    this.parameters = (meta.parameters || []).filter((p) => p.type !== 'trigger');

    this.buildClips();
    this.buildPlayables();
    this.buildScene();
    // Let the state machines settle (default states, entry transitions, parameter drivers) before the first frame.
    for (let i = 0; i < 20; i++) this.step(1 / 30, false);
    this.apply({ fingersTracked: { left: false, right: false } }, false);
    if (this.paths.missing.size) {
      const list = [...this.paths.missing];
      avatar.warnings.push(`vavmeta: ${list.length} path(s) not found: ${list.slice(0, 4).join(', ')}${list.length > 4 ? ' …' : ''}`);
    }
  }

  get missing() {
    return this.paths.missing;
  }

  private declare(p: VrcParameter) {
    if (!p || typeof p.name !== 'string') return;
    this.types.set(p.name, p.type);
    this.defaults.set(p.name, Number(p.default) || 0);
  }

  // ---------------------------------------------------------------------------
  // Parameters

  get(name: string): number {
    return this.values.get(name) ?? this.defaults.get(name) ?? 0;
  }

  defaultOf(name: string): number {
    return this.defaults.get(name) ?? 0;
  }

  typeOf(name: string) {
    return this.types.get(name) || 'float';
  }

  isChanged(name: string) {
    return this.values.has(name) && this.values.get(name) !== this.defaultOf(name);
  }

  private write(name: string, v: number) {
    const type = this.typeOf(name);
    if (type === 'bool' || type === 'trigger') v = v ? 1 : 0;
    else if (type === 'int') v = Math.max(-2147483648, Math.min(2147483647, Math.round(v)));
    else if (this.expressionNames.has(name)) v = Math.max(-1, Math.min(1, v));
    if (!Number.isFinite(v)) v = 0;
    if (this.get(name) === v) return false;
    this.values.set(name, v);
    if (this.expressionNames.has(name)) this.paramsDirty = true;
    return true;
  }

  /** Sets a parameter from the UI (menu, AFK switch, …). */
  set(name: string, v: number) {
    if (this.write(name, v)) this.onChange?.();
  }

  /** Hand gestures from the viewer (Shift+F1–F8, capture app, VRChat OSC). */
  setGesture(left: number, right: number) {
    this.write('GestureLeft', left);
    this.write('GestureRight', right);
    // Desktop VRChat reports a fully pressed trigger while a gesture is held.
    this.write('GestureLeftWeight', left ? 1 : 0);
    this.write('GestureRightWeight', right ? 1 : 0);
  }

  /** Menu values that differ from their defaults, plus AFK (remembered per avatar). */
  savedValues(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const name of this.expressionNames) if (this.isChanged(name)) out[name] = this.get(name);
    if (this.get('AFK')) out.AFK = 1;
    return out;
  }

  /** Applies remembered values and lets the state machines settle, so the first frame already shows them. */
  restore(values: Record<string, number> | undefined) {
    let any = false;
    for (const [name, v] of Object.entries(values || {})) {
      if ((this.expressionNames.has(name) || name === 'AFK') && typeof v === 'number' && this.write(name, v)) any = true;
    }
    if (!any) return;
    for (let i = 0; i < 30; i++) this.step(1 / 30, false);
    this.apply({ fingersTracked: { left: false, right: false } }, false);
    this.paramsDirty = false;
  }

  /** Back to the Expression Parameter defaults (like resetting the avatar in VRChat). */
  reset() {
    for (const name of this.expressionNames) this.values.delete(name);
    this.paramsDirty = true;
    this.onChange?.();
  }

  // ---------------------------------------------------------------------------
  // Setup

  private prop(kind: Kind, path: string, name = '', comp = 0): number {
    const key = `${kind}\u0000${path}\u0000${name}\u0000${comp}`;
    let i = this.propIndex.get(key);
    if (i === undefined) {
      i = this.props.length;
      this.props.push({ kind, path, name, comp });
      this.propIndex.set(key, i);
    }
    return i;
  }

  private buildClips() {
    for (const c of this.meta.clips || []) {
      const curves: CurveRT[] = [];
      const slots: SlotCurveRT[] = [];
      const props = new Set<number>();
      let dynamic = false;
      for (const cv of c.curves || []) {
        const kind = KINDS[cv.k];
        if (kind === undefined || !Array.isArray(cv.v)) continue;
        const comp = cv.c ? COMP[cv.c] ?? 0 : 0;
        const prop = this.prop(kind, cv.p || '', kind === Kind.Param ? cv.n || '' : cv.n || '', comp);
        curves.push({ prop, keys: cv.v });
        props.add(prop);
        if (cv.v.length > 4) dynamic = true;
      }
      for (const m of c.materials || []) {
        const prop = this.prop(Kind.Slot, m.p || '', String(m.slot), 0);
        slots.push({ prop, keys: m.v });
        props.add(prop);
        if (m.v.length > 2) dynamic = true;
      }
      let human: HumanRT | null = null;
      if (c.humanoid && c.humanoid.bones?.length) {
        try {
          human = {
            rate: c.humanoid.rate || 30,
            frames: Math.max(1, c.humanoid.frames | 0),
            bones: c.humanoid.bones,
            rot: decodeFloats(c.humanoid.rot),
            hips: c.humanoid.hips ? decodeFloats(c.humanoid.hips) : null,
          };
          if (human.frames > 1) dynamic = true;
        } catch {
          human = null;
        }
      }
      this.clips.push({
        name: c.name, length: Math.max(0, Number(c.length) || 0), loop: !!c.loop,
        curves, slots, human, props: [...props], dynamic: dynamic && (Number(c.length) || 0) > 0.05,
      });
    }
  }

  private motionProps(m: V2Motion, out: Set<number>, bones: Set<string>, depth = 0) {
    if (!m || depth > 16) return;
    if ('clip' in m) {
      const c = this.clips[m.clip];
      if (!c) return;
      for (const p of c.props) out.add(p);
      if (c.human) for (const b of c.human.bones) bones.add(b);
      if (c.human?.hips) bones.add('hips');
      return;
    }
    for (const ch of m.tree.children || []) this.motionProps(ch.m, out, bones, depth + 1);
  }

  private buildPlayables() {
    for (const p of this.meta.animator?.playables || []) {
      const pl: PlayableRT = { type: p.type, weight: p.type === 'Action' ? 0 : 1, weightTarget: 0, weightRate: 0, layers: [] };
      pl.weightTarget = pl.weight;
      p.layers.forEach((def, index) => {
        const src = def.synced !== undefined ? p.layers[def.synced] : def;
        const any: V2Transition[] = [];
        for (const m of src?.machines || []) for (const t of m.any || []) any.push(t);
        const bound = new Set<number>();
        const bones = new Set<string>();
        for (const s of def.states || []) this.motionProps(s.motion, bound, bones);
        // Avatar mask: transform paths and humanoid body parts the layer may write.
        let boneMask: Set<string> | null = null;
        if (def.mask) {
          boneMask = new Set<string>();
          for (const part of def.mask.humanoid || []) for (const b of BODY_PARTS[part] || []) boneMask.add(b);
          if (def.mask.transforms) {
            const allowed = new Set(def.mask.transforms);
            for (const pi of [...bound]) {
              const prop = this.props[pi];
              if (prop.kind !== Kind.Param && !allowed.has(prop.path)) bound.delete(pi);
            }
          }
        }
        const weight = index === 0 ? 1 : Number(def.weight) || 0;
        pl.layers.push({
          def, playable: pl, index, weight, weightTarget: weight, weightRate: 0, anyTransitions: any,
          bound: [...bound], boneMask, cur: -1, time: 0, next: -1, nextTime: 0, trans: null,
          held: new Map(), humanOut: new Map(), hipsOut: null,
        });
      });
      this.playables.push(pl);
    }
  }

  private buildScene() {
    const d = (this.meta.defaults || {}) as { objects?: { path: string; active: boolean }[]; renderers?: { path: string; enabled: boolean }[]; blendShapes?: { path: string; shape: string; weight: number }[] };
    const inactive = new Set((d.objects || []).filter((o) => !o.active).map((o) => o.path));
    const disabled = new Set((d.renderers || []).filter((o) => !o.enabled).map((o) => o.path));
    const shapeDefaults = new Map<number, number>();
    // Scene blendshape weights are props too (UniVRM does not store them in the VRM).
    for (const s of d.blendShapes || []) shapeDefaults.set(this.prop(Kind.Shape, s.path, s.shape), Number(s.weight) || 0);
    // Inactive objects / disabled renderers hide meshes even when nothing animates them.
    for (const path of inactive) this.prop(Kind.Active, path);
    for (const path of disabled) this.prop(Kind.Enabled, path);

    const vis = new Map<THREE.Object3D, { node: THREE.Object3D; active: number; enabled: number; def: boolean }>();
    const xf = new Map<THREE.Object3D, XfNode>();
    const slotSeen = new Set<number>();
    this.propDefault = this.props.map((p, i) => {
      switch (p.kind) {
        case Kind.Shape: this.shapeProps.push(i); return shapeDefaults.get(i) ?? 0;
        case Kind.Active:
        case Kind.Enabled: {
          const node = this.paths.node(p.path);
          if (node) {
            let e = vis.get(node);
            if (!e) { e = { node, active: -1, enabled: -1, def: true }; vis.set(node, e); }
            if (p.kind === Kind.Active) e.active = i; else e.enabled = i;
          }
          return p.kind === Kind.Active ? (inactive.has(p.path) ? 0 : 1) : (disabled.has(p.path) ? 0 : 1);
        }
        case Kind.Slot:
          if (!slotSeen.has(i)) { slotSeen.add(i); this.slotProps.push({ prop: i, node: this.paths.node(p.path), slot: Number(p.name) || 0, applied: -1 }); }
          return -1;
        case Kind.Param: this.paramProps.push(i); return this.defaultOf(p.name);
        case Kind.Pos: case Kind.Rot: case Kind.Euler: case Kind.Scale: {
          const node = this.paths.node(p.path);
          if (!node) return 0;
          let e = xf.get(node);
          if (!e) {
            const q0 = node.quaternion.clone();
            eTmp.setFromQuaternion(qTmp.set(q0.x, -q0.y, -q0.z, q0.w), 'YXZ');
            const deg = THREE.MathUtils.radToDeg;
            e = {
              node, pos: [-1, -1, -1], rot: [-1, -1, -1, -1], euler: [-1, -1, -1], scale: [-1, -1, -1],
              p0: node.position.clone(), q0, s0: node.scale.clone(), e0: [deg(eTmp.x), deg(eTmp.y), deg(eTmp.z)], touched: false,
            };
            xf.set(node, e);
          }
          const c = Math.min(p.comp, p.kind === Kind.Rot ? 3 : 2);
          if (p.kind === Kind.Pos) { e.pos[c] = i; return e.p0.getComponent(c); }
          if (p.kind === Kind.Scale) { e.scale[c] = i; return e.s0.getComponent(c); }
          if (p.kind === Kind.Rot) { e.rot[c] = i; return [e.q0.x, e.q0.y, e.q0.z, e.q0.w][c]; }
          e.euler[c] = i;
          return e.e0[c];
        }
        default: return 0;
      }
    });
    for (const e of vis.values()) {
      e.def = (e.active < 0 || this.propDefault[e.active] >= 0.5) && (e.enabled < 0 || this.propDefault[e.enabled] >= 0.5);
      this.visNodes.push(e);
    }
    this.transformNodes = [...xf.values()];
    this.stream = Float64Array.from(this.propDefault);
  }

  // ---------------------------------------------------------------------------
  // State machines

  private stateLength(layer: LayerRT, si: number): number {
    const s = this.stateDef(layer, si);
    if (!s) return 1;
    return Math.max(1 / 60, this.motionLength(this.motionOf(layer, si), 0));
  }

  private motionLength(m: V2Motion, depth: number): number {
    if (!m || depth > 16) return 1;
    if ('clip' in m) return this.clips[m.clip]?.length || 0;
    const kids = m.tree.children || [];
    if (!kids.length) return 1;
    if (m.tree.type === 'direct') return Math.max(...kids.map((c) => this.motionLength(c.m, depth + 1)));
    const ws = this.treeWeights(m.tree);
    let sum = 0;
    kids.forEach((c, i) => { if (ws[i] > 0) sum += ws[i] * this.motionLength(c.m, depth + 1) / (c.ts || 1); });
    return sum || 1;
  }

  /** The state definition (synced layers use the source layer's state machine). */
  private stateDef(layer: LayerRT, si: number): V2State | undefined {
    return layer.def.states[si];
  }

  private motionOf(layer: LayerRT, si: number): V2Motion {
    return layer.def.states[si]?.motion ?? null;
  }

  private sourceLayer(layer: LayerRT): LayerRT {
    const s = layer.def.synced;
    return s !== undefined && layer.playable.layers[s] ? layer.playable.layers[s] : layer;
  }

  private test(c: [string, number, number]): boolean {
    const v = this.get(c[0]);
    switch (c[1]) {
      case 1: return v !== 0;
      case 2: return v === 0;
      case 3: return v > c[2];
      case 4: return v < c[2];
      case 6: return Math.abs(v - c[2]) < 1e-5;
      case 7: return Math.abs(v - c[2]) >= 1e-5;
      default: return false;
    }
  }

  private conditionsHold(t: V2Transition) {
    for (const c of t.c || []) if (!this.test(c)) return false;
    return true;
  }

  private consumeTriggers(t: V2Transition) {
    for (const c of t.c || []) if (this.typeOf(c[0]) === 'trigger') this.values.set(c[0], 0);
  }

  /** Destination state of a transition (entering / leaving state machines as needed), or -1. */
  private resolve(layer: LayerRT, t: V2Transition, fromState: number, depth = 0): number {
    if (depth > 16) return -1;
    if (t.to !== undefined) return layer.def.states[t.to] ? t.to : -1;
    if (t.toM !== undefined) return this.enterMachine(layer, t.toM, depth + 1);
    if (t.exit) {
      const m = layer.def.states[fromState]?.m ?? 0;
      return this.exitMachine(layer, m, depth + 1);
    }
    return -1;
  }

  private enterMachine(layer: LayerRT, mi: number, depth = 0): number {
    const m = layer.def.machines[mi];
    if (!m || depth > 16) return -1;
    for (const t of m.entry || []) {
      if (!this.conditionsHold(t)) continue;
      this.consumeTriggers(t);
      const d = this.resolve(layer, t, -1, depth + 1);
      if (d >= 0) return d;
    }
    if (m.default >= 0 && layer.def.states[m.default]) return m.default;
    const first = layer.def.states.findIndex((s) => s.m === mi);
    return first;
  }

  private exitMachine(layer: LayerRT, mi: number, depth = 0): number {
    if (mi <= 0 || depth > 16) return this.enterMachine(layer, 0, depth + 1);
    const parent = layer.def.machines[mi]?.parent ?? 0;
    const exits = layer.def.machines[Math.max(0, parent)]?.exits?.find((e) => e.from === mi);
    for (const t of exits?.t || []) {
      if (!this.conditionsHold(t)) continue;
      this.consumeTriggers(t);
      const d = t.exit ? this.exitMachine(layer, parent, depth + 1) : this.resolve(layer, t, -1, depth + 1);
      if (d >= 0) return d;
    }
    return this.enterMachine(layer, 0, depth + 1);
  }

  private stateSpeed(s: V2State | undefined) {
    if (!s) return 1;
    return (s.speed ?? 1) * (s.speedParam ? this.get(s.speedParam) : 1);
  }

  private enterState(layer: LayerRT, si: number) {
    const s = layer.def.states[si];
    for (const b of s?.behaviours || []) this.runBehaviour(b);
  }

  private exitTimeReached(et: number | undefined, now: number) {
    if (et === undefined) return true;
    if (now < et) return false;
    return et >= 1 || now - Math.floor(now) >= et || now >= 1;
  }

  private beginTransition(layer: LayerRT, t: V2Transition) {
    const dest = this.resolve(layer, t, layer.cur);
    if (dest < 0) return false;
    this.consumeTriggers(t);
    const curLen = this.stateLength(layer, layer.cur) / Math.max(1e-3, Math.abs(this.stateSpeed(layer.def.states[layer.cur])));
    const seconds = Math.max(0, (t.d ?? 0) * (t.fixed ? 1 : curLen));
    layer.next = dest;
    layer.nextTime = t.o ?? 0;
    this.enterState(layer, dest);
    if (seconds <= 1e-4) {
      layer.cur = dest;
      layer.time = layer.nextTime;
      layer.next = -1;
      layer.trans = null;
    } else {
      layer.trans = { elapsed: 0, duration: seconds };
    }
    return true;
  }

  private stepLayer(layer: LayerRT, dt: number) {
    if (layer.def.synced !== undefined) return;
    if (!layer.def.states.length) return;
    if (layer.cur < 0) {
      layer.cur = this.enterMachine(layer, 0);
      if (layer.cur < 0) return;
      const s = layer.def.states[layer.cur];
      layer.time = (s.cycleOffset ?? 0) + (s.cycleOffsetParam ? this.get(s.cycleOffsetParam) : 0);
      this.enterState(layer, layer.cur);
      return;
    }
    const cur = layer.def.states[layer.cur];
    if (cur.timeParam) layer.time = this.get(cur.timeParam);
    else layer.time += dt * this.stateSpeed(cur) / this.stateLength(layer, layer.cur);
    if (layer.trans) {
      const next = layer.def.states[layer.next];
      if (next?.timeParam) layer.nextTime = this.get(next.timeParam);
      else layer.nextTime += dt * this.stateSpeed(next) / this.stateLength(layer, layer.next);
      layer.trans.elapsed += dt;
      if (layer.trans.elapsed >= layer.trans.duration) {
        layer.cur = layer.next;
        layer.time = layer.nextTime;
        layer.next = -1;
        layer.trans = null;
      }
      return;
    }
    // Any State transitions first, then the current state's own.
    for (const t of layer.anyTransitions) {
      if (t.to === layer.cur && !t.self) continue;
      if (!t.c?.length) continue;
      if (!this.conditionsHold(t)) continue;
      if (this.beginTransition(layer, t)) return;
    }
    for (const t of cur.transitions || []) {
      if ((t.c?.length || 0) === 0 && t.et === undefined) continue;
      if (!this.exitTimeReached(t.et, layer.time)) continue;
      if (!this.conditionsHold(t)) continue;
      if (this.beginTransition(layer, t)) return;
    }
  }

  // ---------------------------------------------------------------------------
  // State behaviours

  private runBehaviour(b: V2Behaviour) {
    switch (b.type) {
      case 'driver':
        for (const op of b.ops || []) this.runDriver(op);
        break;
      case 'playable': {
        const pl = this.playables.find((p) => p.type === b.layer);
        if (pl) this.blendTo(pl, b.goal, b.dur);
        break;
      }
      case 'layer': {
        const pl = this.playables.find((p) => p.type === b.playable);
        const layer = pl?.layers[b.layer];
        if (layer && layer.index > 0) this.blendTo(layer, b.goal, b.dur);
        break;
      }
      case 'tracking':
        for (const [k, v] of Object.entries(b)) if (k !== 'type') this.tracking[k] = v as string;
        break;
      default:
        break;
    }
  }

  private blendTo(target: { weight: number; weightTarget: number; weightRate: number }, goal: number, duration: number) {
    target.weightTarget = Math.max(0, Math.min(1, goal));
    if (!(duration > 0)) { target.weight = target.weightTarget; target.weightRate = 0; return; }
    target.weightRate = Math.abs(target.weightTarget - target.weight) / duration;
  }

  private runDriver(op: V2DriverOp) {
    const name = op.n;
    if (!name) return;
    const type = this.typeOf(name);
    switch (op.t) {
      case 'set': this.write(name, op.v); break;
      case 'add': this.write(name, this.get(name) + op.v); break;
      case 'random':
        if (type === 'bool' || type === 'trigger') this.write(name, Math.random() < (op.ch ?? 0.5) ? 1 : 0);
        else if (type === 'int') this.write(name, Math.floor(op.min + Math.random() * (op.max - op.min + 1)));
        else this.write(name, op.min + Math.random() * (op.max - op.min));
        break;
      case 'copy': {
        let v = this.get(op.s || '');
        if (op.range) {
          const [smin, smax, dmin, dmax] = op.range;
          const t = smax !== smin ? (v - smin) / (smax - smin) : 0;
          v = dmin + (dmax - dmin) * t;
        }
        this.write(name, v);
        break;
      }
      default: break;
    }
  }

  private updateWeights(dt: number) {
    const move = (o: { weight: number; weightTarget: number; weightRate: number }) => {
      if (o.weight === o.weightTarget) return;
      const step = o.weightRate > 0 ? o.weightRate * dt : 1;
      o.weight = o.weight < o.weightTarget ? Math.min(o.weightTarget, o.weight + step) : Math.max(o.weightTarget, o.weight - step);
    };
    for (const pl of this.playables) {
      move(pl);
      for (const l of pl.layers) move(l);
    }
  }

  // ---------------------------------------------------------------------------
  // Motion evaluation

  private treeWeights(tree: V2Tree): number[] {
    const kids = tree.children || [];
    const w = new Array(kids.length).fill(0);
    if (!kids.length) return w;
    if (tree.type === 'direct') {
      kids.forEach((c, i) => { w[i] = c.dp ? this.get(c.dp) : 0; });
      return w;
    }
    if (tree.type === '1d') {
      const v = this.get(tree.p || '');
      const order = kids.map((c, i) => [c.th ?? 0, i]).sort((a, b) => a[0] - b[0]);
      if (v <= order[0][0]) { w[order[0][1]] = 1; return w; }
      const last = order[order.length - 1];
      if (v >= last[0]) { w[last[1]] = 1; return w; }
      for (let i = 0; i < order.length - 1; i++) {
        const [ta, ia] = order[i], [tb, ib] = order[i + 1];
        if (v < ta || v > tb) continue;
        const t = tb > ta ? (v - ta) / (tb - ta) : 0;
        w[ia] = 1 - t;
        w[ib] = t;
        return w;
      }
      return w;
    }
    // 2D: gradient band interpolation (freeform cartesian), used for all 2D blend types.
    const px = this.get(tree.p || ''), py = this.get(tree.p2 || '');
    let total = 0;
    for (let i = 0; i < kids.length; i++) {
      const [xi, yi] = kids[i].pos || [0, 0];
      let wi = 1;
      for (let j = 0; j < kids.length; j++) {
        if (i === j) continue;
        const [xj, yj] = kids[j].pos || [0, 0];
        const dx = xj - xi, dy = yj - yi;
        const len2 = dx * dx + dy * dy;
        if (len2 < 1e-9) continue;
        const h = 1 - ((px - xi) * dx + (py - yi) * dy) / len2;
        wi = Math.min(wi, Math.max(0, h));
      }
      w[i] = wi;
      total += wi;
    }
    if (total > 0) for (let i = 0; i < w.length; i++) w[i] /= total;
    return w;
  }

  private evalMotion(m: V2Motion, nt: number, weight: number, acc: Acc, depth = 0) {
    if (!m || weight <= 1e-5 || depth > 16) return;
    if ('clip' in m) {
      const c = this.clips[m.clip];
      if (c) this.evalClip(c, nt, weight, acc);
      return;
    }
    const ws = this.treeWeights(m.tree);
    m.tree.children.forEach((child, i) => {
      if (ws[i] > 1e-5) this.evalMotion(child.m, nt * (child.ts || 1), weight * ws[i], acc, depth + 1);
    });
  }

  private evalClip(c: ClipRT, nt: number, weight: number, acc: Acc) {
    const len = c.length;
    const t = len <= 0 ? 0 : c.loop ? (nt - Math.floor(nt)) * len : Math.min(1, Math.max(0, nt)) * len;
    for (const cv of c.curves) {
      const v = evalCurve(cv.keys, t);
      const e = acc.values.get(cv.prop);
      if (e) { e[0] += v * weight; e[1] += weight; } else acc.values.set(cv.prop, [v * weight, weight]);
    }
    for (const sc of c.slots) {
      // Object reference curves: the key at or before t; the heaviest motion wins.
      let v = sc.keys[1];
      for (let i = 0; i < sc.keys.length; i += 2) if (sc.keys[i] <= t + 1e-5) v = sc.keys[i + 1];
      const e = acc.values.get(sc.prop);
      if (!e || weight > e[1]) acc.values.set(sc.prop, [v * weight, weight]);
    }
    const h = c.human;
    if (h) {
      const f = Math.min(h.frames - 1, Math.max(0, t * h.rate));
      const f0 = Math.floor(f), f1 = Math.min(h.frames - 1, f0 + 1), k = f - f0;
      const nb = h.bones.length;
      for (let i = 0; i < nb; i++) {
        const a = (f0 * nb + i) * 4, b = (f1 * nb + i) * 4;
        qTmp.set(h.rot[a], h.rot[a + 1], h.rot[a + 2], h.rot[a + 3]);
        if (k > 0) qTmp.slerp(qTmp2.set(h.rot[b], h.rot[b + 1], h.rot[b + 2], h.rot[b + 3]), k);
        const e = acc.bones.get(h.bones[i]);
        if (!e) acc.bones.set(h.bones[i], [qTmp.clone(), weight]);
        else {
          const sum = e[1] + weight;
          e[0].slerp(qTmp, weight / sum);
          e[1] = sum;
        }
      }
      if (h.hips) {
        const a = f0 * 3, b = f1 * 3;
        const x = h.hips[a] + (h.hips[b] - h.hips[a]) * k;
        const y = h.hips[a + 1] + (h.hips[b + 1] - h.hips[a + 1]) * k;
        const z = h.hips[a + 2] + (h.hips[b + 2] - h.hips[a + 2]) * k;
        if (!acc.hips) acc.hips = [new THREE.Vector3(x, y, z), weight];
        else {
          const sum = acc.hips[1] + weight;
          acc.hips[0].lerp(new THREE.Vector3(x, y, z), weight / sum);
          acc.hips[1] = sum;
        }
      }
    }
  }

  /**
   * Evaluates one layer (crossfading during a transition) and writes it into the stream with the layer weight.
   * Unity semantics: every frame starts from the scene defaults; a layer overrides the properties its current
   * state animates. A Write Defaults ON state leaves everything else alone (lower layers / defaults show through,
   * so an empty "Idle" clip does not hide the other hand's gesture), while a WD OFF state keeps writing the last
   * value of the layer's other properties (toggles stay as they were).
   */
  private composeLayer(layer: LayerRT, weight: number) {
    layer.humanOut.clear();
    layer.hipsOut = null;
    const src = this.sourceLayer(layer);
    if (src.cur < 0) return;
    const acc: Acc = { values: new Map(), bones: new Map(), hips: null };
    const k = src.trans ? Math.min(1, src.trans.elapsed / src.trans.duration) : 0;
    this.evalMotion(this.motionOf(layer, src.cur), src.time, 1 - k, acc);
    if (src.trans && src.next >= 0) this.evalMotion(this.motionOf(layer, src.next), src.nextTime, k, acc);
    const wd = layer.def.states[src.trans && src.next >= 0 ? src.next : src.cur]?.wd !== false;
    const s = this.stream;
    for (const p of layer.bound) {
      const e = acc.values.get(p);
      if (!e && wd) continue;
      let v: number;
      if (this.props[p].kind === Kind.Slot) {
        // Object references are not blended.
        v = e && e[1] > 0 ? Math.round(e[0] / e[1]) : layer.held.get(p) ?? s[p];
        layer.held.set(p, v);
        if (weight >= 0.5) s[p] = v;
        continue;
      }
      const base = wd ? s[p] : layer.held.get(p) ?? s[p];
      v = !e ? base : e[1] >= 0.999 ? e[0] : e[0] + (1 - e[1]) * base;
      layer.held.set(p, v);
      if (weight <= 1e-4) continue;
      if (layer.def.additive) s[p] += (v - this.propDefault[p]) * weight;
      else s[p] = weight >= 0.9999 ? v : s[p] + (v - s[p]) * weight;
    }
    for (const [bone, [q, w]] of acc.bones) {
      if (layer.boneMask && !layer.boneMask.has(bone)) continue;
      layer.humanOut.set(bone, [q.normalize(), Math.min(1, w)]);
    }
    if (acc.hips && (!layer.boneMask || layer.boneMask.has('hips'))) layer.hipsOut = [acc.hips[0], Math.min(1, acc.hips[1])];
  }

  // ---------------------------------------------------------------------------
  // Frame update

  /** Whether the animator needs smooth frames (crossfades, animated states, blending weights). */
  get busy(): boolean {
    for (const pl of this.playables) {
      if (pl.weight !== pl.weightTarget) return true;
      if (pl.type === 'Action' && pl.weight > 0) return true;
      for (const l of pl.layers) {
        if (l.trans || l.weight !== l.weightTarget) return true;
        if (l.weight <= 0 || l.cur < 0) continue;
        const m = this.motionOf(l, l.cur);
        if (m && 'clip' in m && this.clips[m.clip]?.dynamic && (this.clips[m.clip].loop || l.time < 1)) return true;
      }
    }
    return false;
  }

  private step(dt: number, notify = true) {
    for (const pl of this.playables) for (const l of pl.layers) this.stepLayer(l, dt);
    this.updateWeights(dt);
    this.compose();
    // Animated animator parameters (AAP) feed the next frame's conditions.
    for (const p of this.paramProps) {
      const name = this.props[p].name;
      if (this.typeOf(name) === 'float' && !this.expressionNames.has(name)) this.values.set(name, this.stream[p]);
    }
    if (notify && this.paramsDirty) {
      this.paramsDirty = false;
      this.onParamsChange?.();
    }
  }

  private compose() {
    this.stream.set(this.propDefault);
    for (const pl of this.playables) {
      for (const l of pl.layers) this.composeLayer(l, (l.index === 0 ? 1 : l.weight) * pl.weight);
    }
  }

  /** Advances the animator and applies the result; call before avatar.update(). */
  update(dt: number, tick: AnimatorTick) {
    this.step(dt);
    this.apply(tick, true);
  }

  private apply(tick: AnimatorTick, humanoid: boolean) {
    const s = this.stream;
    // Blendshapes
    const morphs = new Map<string, number>();
    for (const p of this.shapeProps) {
      const v = s[p];
      if (Math.abs(v) < 1e-4) continue;
      const prop = this.props[p];
      for (const k of this.paths.morphKeys(prop.path, prop.name)) morphs.set(k, Math.min(1, Math.max(0, v)));
    }
    this.avatar.setLayer('vrc-fx', morphs);
    // Objects / renderers
    for (const e of this.visNodes) {
      const on = (e.active < 0 || s[e.active] >= 0.5) && (e.enabled < 0 || s[e.enabled] >= 0.5);
      if (e.node.visible !== on) e.node.visible = on;
    }
    // Material slots
    for (const e of this.slotProps) {
      const v = Math.round(s[e.prop]);
      if (v === e.applied || !e.node) continue;
      e.applied = v;
      this.swapMaterial(e.node, e.slot, v);
    }
    // Generic transforms
    for (const e of this.transformNodes) this.applyTransform(e);
    if (humanoid) this.applyHumanoid(tick);
  }

  private applyTransform(e: XfNode) {
    const s = this.stream, d = this.propDefault;
    let changed = false;
    const anyChanged = (ids: number[]) => ids.some((i) => i >= 0 && Math.abs(s[i] - d[i]) > 1e-6);
    changed = anyChanged(e.pos) || anyChanged(e.rot) || anyChanged(e.euler) || anyChanged(e.scale);
    if (!changed) {
      if (e.touched) {
        e.node.position.copy(e.p0);
        e.node.quaternion.copy(e.q0);
        e.node.scale.copy(e.s0);
        e.touched = false;
      }
      return;
    }
    e.touched = true;
    e.node.position.set(
      e.pos[0] >= 0 ? s[e.pos[0]] : e.p0.x, e.pos[1] >= 0 ? s[e.pos[1]] : e.p0.y, e.pos[2] >= 0 ? s[e.pos[2]] : e.p0.z);
    e.node.scale.set(
      e.scale[0] >= 0 ? s[e.scale[0]] : e.s0.x, e.scale[1] >= 0 ? s[e.scale[1]] : e.s0.y, e.scale[2] >= 0 ? s[e.scale[2]] : e.s0.z);
    if (e.rot.some((i) => i >= 0)) {
      e.node.quaternion.set(
        e.rot[0] >= 0 ? s[e.rot[0]] : e.q0.x, e.rot[1] >= 0 ? s[e.rot[1]] : e.q0.y,
        e.rot[2] >= 0 ? s[e.rot[2]] : e.q0.z, e.rot[3] >= 0 ? s[e.rot[3]] : e.q0.w).normalize();
    } else if (e.euler.some((i) => i >= 0)) {
      // Unity Quaternion.Euler(x, y, z) = Y·X·Z, then mirrored into glTF space.
      const r = THREE.MathUtils.degToRad;
      const deg = (c: number) => (e.euler[c] >= 0 ? s[e.euler[c]] : e.e0[c]);
      qTmp.setFromEuler(eTmp.set(r(deg(0)), r(deg(1)), r(deg(2)), 'YXZ'));
      e.node.quaternion.set(qTmp.x, -qTmp.y, -qTmp.z, qTmp.w);
    }
  }

  /** Humanoid output of the Gesture (fingers) and Action playables on top of the viewer's own pose. */
  private applyHumanoid(tick: AnimatorTick) {
    const pose = new Map<string, [THREE.Quaternion, number]>();
    let hips: [THREE.Vector3, number] | null = null;
    for (const pl of this.playables) {
      if (pl.type !== 'Action' && pl.type !== 'Gesture') continue;
      const pw = pl.weight;
      if (pw <= 1e-4) continue;
      for (const l of pl.layers) {
        const lw = (l.index === 0 ? 1 : l.weight) * pw;
        if (lw <= 1e-4) continue;
        for (const [bone, [q, w]] of l.humanOut) {
          if (pl.type === 'Gesture') {
            const side = FINGER_SIDE.get(bone);
            if (!side || tick.fingersTracked[side]) continue; // VRChat masks the Gesture layer to the hands
          }
          const k = lw * w;
          const e = pose.get(bone);
          if (!e) pose.set(bone, [q.clone(), k]);
          else { e[0].slerp(q, k); e[1] = e[1] + (1 - e[1]) * k; }
        }
        if (l.hipsOut && pl.type === 'Action') {
          const k = lw * l.hipsOut[1];
          if (!hips) hips = [l.hipsOut[0].clone(), k];
          else { hips[0].lerp(l.hipsOut[0], k); hips[1] = hips[1] + (1 - hips[1]) * k; }
        }
      }
    }

    // Blend from the pose the viewer set this frame. A bone nobody else wrote since our last frame
    // keeps its pre-animator rotation as the base, so it returns there when the animation ends.
    for (const [bone, rec] of this.boneBase) {
      if (pose.has(bone)) continue;
      const node = this.avatar.normalizedBone(bone);
      if (node && node.quaternion.equals(rec.written)) node.quaternion.copy(rec.base);
      this.boneBase.delete(bone);
    }
    for (const [bone, [q, w]] of pose) {
      const node = this.avatar.normalizedBone(bone);
      if (!node) continue;
      let rec = this.boneBase.get(bone);
      if (!rec) { rec = { written: new THREE.Quaternion(NaN), base: node.quaternion.clone() }; this.boneBase.set(bone, rec); }
      if (!node.quaternion.equals(rec.written)) rec.base.copy(node.quaternion);
      node.quaternion.copy(rec.base).slerp(q, Math.min(1, w));
      rec.written.copy(node.quaternion);
    }
    const hipsNode = this.avatar.normalizedBone('hips');
    if (hipsNode) {
      if (hips) {
        if (!this.hipsBase) this.hipsBase = { written: new THREE.Vector3(NaN), base: hipsNode.position.clone() };
        if (!hipsNode.position.equals(this.hipsBase.written)) this.hipsBase.base.copy(hipsNode.position);
        hipsNode.position.copy(this.hipsBase.base).lerp(hips[0], Math.min(1, hips[1]));
        this.hipsBase.written.copy(hipsNode.position);
      } else if (this.hipsBase) {
        if (hipsNode.position.equals(this.hipsBase.written)) hipsNode.position.copy(this.hipsBase.base);
        this.hipsBase = null;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Material swaps

  private loadMaterial(index: number): Promise<THREE.Material | null> {
    let p = this.loadedMaterials.get(index);
    if (!p) {
      const entry = this.meta.materials?.[index];
      const parser = (this.avatar.gltf as any).parser;
      p = entry && entry.index >= 0 && parser
        ? (parser.getDependency('material', entry.index) as Promise<THREE.Material>).catch((err: unknown) => {
          console.warn('[vrc] material', entry.name, err);
          return null;
        })
        : Promise.resolve(null);
      this.loadedMaterials.set(index, p);
    }
    return p;
  }

  private withOutline(mat: THREE.Material, mesh: THREE.Mesh): THREE.Material | THREE.Material[] {
    const m = mat as any;
    if (!m.isMToonMaterial || !m.outlineWidthMode || m.outlineWidthMode === 'none' || !(m.outlineWidthFactor > 0)) return mat;
    let outline = this.outlineMaterials.get(mat);
    if (!outline) {
      outline = mat.clone();
      outline.name += ' (Outline)';
      (outline as any).isOutline = true;
      outline.side = THREE.BackSide;
      this.outlineMaterials.set(mat, outline);
    }
    const g = mesh.geometry;
    if (!g.groups.length) {
      const count = g.index ? g.index.count : g.attributes.position.count;
      g.addGroup(0, count, 0);
      g.addGroup(0, count, 1);
    }
    return [mat, outline];
  }

  private swapMaterial(node: THREE.Object3D, slot: number, index: number) {
    const mesh = this.paths.slotMeshes(node)[slot];
    if (!mesh) return;
    if (!this.originalMaterials.has(mesh)) this.originalMaterials.set(mesh, { material: mesh.material, renderOrder: mesh.renderOrder });
    const token = (this.swapTokens.get(mesh) || 0) + 1;
    this.swapTokens.set(mesh, token);
    if (index < 0) {
      const o = this.originalMaterials.get(mesh)!;
      mesh.material = o.material;
      return;
    }
    this.loadMaterial(index).then((mat) => {
      if (!mat || this.swapTokens.get(mesh) !== token) return;
      mesh.material = this.withOutline(mat, mesh);
      this.onChange?.();
    });
  }

  // ---------------------------------------------------------------------------
  // Built-in avatar animations (for the animation player)

  /** Humanoid clips with motion (dances, AFK, …), excluding single-frame poses and VRChat proxy placeholders. */
  animations(): AvatarAnimation[] {
    const out: AvatarAnimation[] = [];
    const seen = new Set<string>();
    this.clips.forEach((c, i) => {
      if (!c.human || c.human.frames < 6 || /^proxy_/i.test(c.name)) return;
      const name = c.name.replace(/^rebased /, '');
      if (seen.has(name)) return;
      seen.add(name);
      out.push({ clip: i, name, length: c.length, loop: c.loop });
    });
    return out;
  }

  /** A clip's humanoid motion (and its blendshape curves) as a three.js clip on the normalized bones. */
  toAnimationClip(index: number): THREE.AnimationClip | null {
    const c = this.clips[index];
    const h = c?.human;
    if (!c || !h) return null;
    const times = new Float32Array(h.frames);
    for (let f = 0; f < h.frames; f++) times[f] = Math.min(c.length, f / h.rate);
    const tracks: THREE.KeyframeTrack[] = [];
    const nb = h.bones.length;
    h.bones.forEach((bone, i) => {
      const node = this.avatar.normalizedBone(bone);
      if (!node) return;
      const values = new Float32Array(h.frames * 4);
      for (let f = 0; f < h.frames; f++) values.set(h.rot.subarray((f * nb + i) * 4, (f * nb + i) * 4 + 4), f * 4);
      tracks.push(new THREE.QuaternionKeyframeTrack(`${node.name}.quaternion`, times, values));
    });
    const hipsNode = this.avatar.normalizedBone('hips');
    if (h.hips && hipsNode) tracks.push(new THREE.VectorKeyframeTrack(`${hipsNode.name}.position`, times, h.hips.slice(0, h.frames * 3)));
    for (const cv of c.curves) {
      const prop = this.props[cv.prop];
      if (prop.kind !== Kind.Shape) continue;
      const node = this.paths.node(prop.path);
      if (!node) continue;
      for (const m of this.paths.slotMeshes(node)) {
        const idx = m.morphTargetDictionary?.[prop.name];
        if (idx === undefined) continue;
        const values = new Float32Array(h.frames);
        for (let f = 0; f < h.frames; f++) values[f] = Math.min(1, Math.max(0, evalCurve(cv.keys, times[f])));
        tracks.push(new THREE.NumberKeyframeTrack(`${m.uuid}.morphTargetInfluences[${idx}]`, times, values));
      }
    }
    return new THREE.AnimationClip(c.name, c.length, tracks);
  }

  // ---------------------------------------------------------------------------

  dispose() {
    this.avatar.clearLayer('vrc-fx');
    for (const e of this.visNodes) e.node.visible = true;
    for (const [mesh, o] of this.originalMaterials) { mesh.material = o.material; mesh.renderOrder = o.renderOrder; }
    for (const e of this.transformNodes) { e.node.position.copy(e.p0); e.node.quaternion.copy(e.q0); e.node.scale.copy(e.s0); }
    for (const [bone, rec] of this.boneBase) {
      const node = this.avatar.normalizedBone(bone);
      if (node) node.quaternion.copy(rec.base);
    }
    this.boneBase.clear();
  }
}
