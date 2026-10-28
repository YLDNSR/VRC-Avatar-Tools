// VRChat sidecar (<name>.vavmeta.json, written by unity-exporter/). Format: docs/vavmeta.md.
// Version 2 carries the avatar's playable layers and runs in VrcAnimator (vrcAnimator.ts).
// Version 1 (Expression Parameters / Menu, gesture map and FX toggle layers) is evaluated here like an
// Animator with Write Defaults on: each layer's active state overrides the scene defaults, later layers
// win. The result drives the 'vrc-fx' morph layer and the visibility of the objects the sidecar mentions.
import * as THREE from 'three';
import type { Avatar } from './avatar';
import { VrcAnimator, type V2Meta } from './vrcAnimator';

export interface VrcShape { path: string; shape: string; weight: number }
export interface VrcObject { path: string; active: boolean }
export interface VrcEffect { clip?: string; blendShapes?: VrcShape[]; objects?: VrcObject[] }
export interface VrcBlend { blend: string; children: { threshold: number; motion: VrcMotion | null }[] }
export interface VrcDirect { direct: { parameter: string; motion: VrcMotion | null }[] }
export type VrcMotion = VrcEffect | VrcBlend | VrcDirect;
export interface VrcCondition { parameter: string; mode: 'if' | 'ifNot' | 'greater' | 'less' | 'equals' | 'notEqual'; threshold?: number }
export interface VrcState { name: string; default?: boolean; when?: VrcCondition[][]; motion?: VrcMotion | null }
export interface VrcLayer { layer: string; states: VrcState[] }
export interface VrcParameter { name: string; type: 'bool' | 'int' | 'float' | 'trigger'; default: number; saved?: boolean; synced?: boolean }
export interface VrcControl {
  name: string;
  type: 'button' | 'toggle' | 'subMenu' | 'twoAxisPuppet' | 'fourAxisPuppet' | 'radialPuppet' | string;
  parameter?: string;
  value?: number;
  subParameters?: string[];
  labels?: string[];
  menu?: VrcMenu | null;
  /** Index into the sidecar's icons (version 2). */
  icon?: number;
  labelIcons?: number[];
}
export interface VrcMenu { name?: string; controls: VrcControl[] }
export interface VavMeta {
  format: 'vav-vrchat-meta';
  version: number;
  avatar?: string;
  vrm?: string;
  parameters: VrcParameter[];
  localParameters?: VrcParameter[];
  menu?: VrcMenu | null;
  gestures?: { left?: (VrcEffect | null)[]; right?: (VrcEffect | null)[] };
  toggles?: VrcLayer[];
  defaults?: { objects?: VrcObject[]; renderers?: { path: string; enabled: boolean }[]; blendShapes?: VrcShape[] };
  warnings?: string[];
}

/** Resolved gesture effect: morph keys (Avatar layer keys) and objects. */
export interface GestureEffect { morphs: [string, number][]; objects: [THREE.Object3D, boolean][] }

/** Built-in VRChat parameters, with values that fit a desktop viewer. */
const BUILTIN: Record<string, number> = {
  IsLocal: 1, Grounded: 1, Upright: 1, TrackingType: 3, VRMode: 0, AFK: 0, Seated: 0, InStation: 0,
  MuteSelf: 0, Earmuffs: 0, Viseme: 0, Voice: 0, GestureLeft: 0, GestureRight: 0, GestureLeftWeight: 0,
  GestureRightWeight: 0, AngularY: 0, VelocityX: 0, VelocityY: 0, VelocityZ: 0, VelocityMagnitude: 0,
  IsAnimatorEnabled: 1, IsOnFriendsList: 0, AvatarVersion: 3, ScaleModified: 0, ScaleFactor: 1,
  ScaleFactorInverse: 1, EyeHeightAsMeters: 1.6, EyeHeightAsPercent: 0.5, PreviewMode: 0,
};

export function sidecarPath(avatarPath: string) {
  return avatarPath.replace(/\.(vrm|glb|gltf)$/i, '') + '.vavmeta.json';
}

export function parseVavMeta(text: string): VavMeta {
  const meta = JSON.parse(text) as VavMeta;
  if (!meta || meta.format !== 'vav-vrchat-meta') throw new Error('not a vav-vrchat-meta file');
  if (meta.version !== 1 && meta.version !== 2) throw new Error(`unsupported version ${meta.version}`);
  meta.parameters = Array.isArray(meta.parameters) ? meta.parameters : [];
  meta.toggles = Array.isArray(meta.toggles) ? meta.toggles : [];
  return meta;
}

/** The loaded sidecar: a v2 animator, or the v1 FX toggle evaluator. */
export type VrcRuntime = VrcFx | VrcAnimator;

export function createVrcRuntime(avatar: Avatar, meta: VavMeta): VrcRuntime {
  return meta.version >= 2 ? new VrcAnimator(avatar, meta as V2Meta) : new VrcFx(avatar, meta);
}

function sanitize(name: string) {
  return THREE.PropertyBinding.sanitizeNodeName(name);
}

type Acc = { shapes: Map<string, number>; objects: Map<string, [number, number]> };

export class VrcFx {
  readonly meta: VavMeta;
  readonly icons: string[] = [];
  readonly avatar: Avatar;
  /** Expression parameters in menu order (bool / int / float). */
  readonly parameters: VrcParameter[];
  /** Paths in the sidecar that do not exist in the loaded avatar. */
  readonly missing = new Set<string>();
  onChange?: () => void;

  private values = new Map<string, number>();
  private defaults = new Map<string, number>();
  private types = new Map<string, string>();
  private nodes = new Map<string, THREE.Object3D | null>();
  private shapeKeys = new Map<string, string[]>();
  private gestureCache = new Map<string, GestureEffect | null>();
  private fxObjects = new Map<THREE.Object3D, boolean>();
  private overlay = new Map<THREE.Object3D, boolean>();
  private touched = new Set<THREE.Object3D>();

  constructor(avatar: Avatar, meta: VavMeta) {
    this.avatar = avatar;
    this.meta = meta;
    for (const p of meta.localParameters || []) this.declare(p);
    for (const p of meta.parameters) this.declare(p);
    this.parameters = meta.parameters.filter((p) => p.type !== 'trigger');
    this.apply();
    if (this.missing.size) {
      const list = [...this.missing];
      avatar.warnings.push(`vavmeta: ${list.length} path(s) not found: ${list.slice(0, 4).join(', ')}${list.length > 4 ? ' …' : ''}`);
    }
  }

  private declare(p: VrcParameter) {
    if (!p || typeof p.name !== 'string') return;
    this.types.set(p.name, p.type);
    this.defaults.set(p.name, Number(p.default) || 0);
  }

  get hasGestures() {
    const g = this.meta.gestures;
    return !!g && [...(g.left || []), ...(g.right || [])].some((e) => e && ((e.blendShapes?.length || 0) + (e.objects?.length || 0)) > 0);
  }

  get(name: string): number {
    return this.values.get(name) ?? this.defaults.get(name) ?? BUILTIN[name] ?? 0;
  }

  defaultOf(name: string): number {
    return this.defaults.get(name) ?? BUILTIN[name] ?? 0;
  }

  typeOf(name: string) {
    return this.types.get(name) || 'float';
  }

  isChanged(name: string) {
    return this.values.has(name) && this.values.get(name) !== this.defaultOf(name);
  }

  set(name: string, v: number) {
    const type = this.typeOf(name);
    if (type === 'bool') v = v ? 1 : 0;
    else if (type === 'int') v = Math.max(0, Math.min(255, Math.round(v)));
    else v = Math.max(-1, Math.min(1, v));
    if (this.get(name) === v) return;
    if (v === this.defaultOf(name)) this.values.delete(name); else this.values.set(name, v);
    this.apply();
    this.onChange?.();
  }

  reset() {
    this.values.clear();
    this.apply();
    this.onChange?.();
  }

  /** Parameters that differ from their defaults (remembered per avatar). */
  savedValues(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [name, v] of this.values) if (v !== this.defaultOf(name)) out[name] = v;
    return out;
  }

  restore(values: Record<string, number> | undefined) {
    let any = false;
    for (const [name, v] of Object.entries(values || {})) {
      if (!this.types.has(name) || typeof v !== 'number') continue;
      if (v === this.defaultOf(name)) this.values.delete(name); else this.values.set(name, v);
      any = true;
    }
    if (any) this.apply();
  }

  // ---------------------------------------------------------------------------
  // Paths → three.js objects. GLTFLoader keeps the original glTF name in userData.name and
  // makes node.name unique + sanitized ("Outfit A" → "Outfit_A", second "Hat" → "Hat_1").

  node(path: string): THREE.Object3D | null {
    if (this.nodes.has(path)) return this.nodes.get(path)!;
    let found: THREE.Object3D | null = this.walk(path.split('/'));
    if (!found) {
      // Fall back to the first object with the last name anywhere in the avatar.
      const last = path.split('/').pop() || '';
      this.avatar.scene.traverse((o) => { if (!found && (o.userData?.name === last || o.name === sanitize(last))) found = o; });
    }
    if (!found) this.missing.add(path);
    this.nodes.set(path, found);
    return found;
  }

  private walk(segments: string[]): THREE.Object3D | null {
    let cur: THREE.Object3D = this.avatar.scene;
    for (const seg of segments) {
      const s = sanitize(seg);
      const kids = cur.children;
      const next = kids.find((c) => c.userData?.name === seg) || kids.find((c) => c.name === s) ||
        kids.find((c) => c.name.startsWith(s + '_') && /^\d+$/.test(c.name.slice(s.length + 1)));
      if (!next) return null;
      cur = next;
    }
    return cur;
  }

  /** Avatar morph layer keys for a blendshape on the mesh at path (multi-primitive meshes are groups). */
  morphKeys(path: string, shape: string): string[] {
    const id = `${path}\u0000${shape}`;
    const cached = this.shapeKeys.get(id);
    if (cached) return cached;
    const keys: string[] = [];
    const n = this.node(path);
    if (n) {
      const meshes = (n as THREE.Mesh).isMesh ? [n as THREE.Mesh] : (n.children.filter((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh[]);
      for (const m of meshes) {
        const index = m.morphTargetDictionary?.[shape];
        if (index !== undefined) keys.push(`m:${m.uuid}:${index}`);
      }
      if (!keys.length) this.missing.add(`${path} / ${shape}`);
    }
    this.shapeKeys.set(id, keys);
    return keys;
  }

  // ---------------------------------------------------------------------------
  // Gestures

  /** Effect of a hand gesture from the FX gesture map (null when the sidecar has none for it). */
  gesture(side: 'left' | 'right', index: number): GestureEffect | null {
    const id = `${side}:${index}`;
    if (this.gestureCache.has(id)) return this.gestureCache.get(id)!;
    const e = this.meta.gestures?.[side]?.[index] || null;
    let out: GestureEffect | null = null;
    if (e && ((e.blendShapes?.length || 0) + (e.objects?.length || 0)) > 0) {
      out = { morphs: [], objects: [] };
      for (const s of e.blendShapes || []) for (const k of this.morphKeys(s.path, s.shape)) out.morphs.push([k, s.weight]);
      for (const o of e.objects || []) { const n = this.node(o.path); if (n) out.objects.push([n, !!o.active]); }
    }
    this.gestureCache.set(id, out);
    return out;
  }

  /** Object visibility requested by the active gesture; overrides the FX layers while held. */
  setGestureObjects(objects: Map<THREE.Object3D, boolean>) {
    if (objects.size === this.overlay.size && [...objects].every(([n, v]) => this.overlay.get(n) === v)) return;
    this.overlay = objects;
    this.applyVisibility();
  }

  // ---------------------------------------------------------------------------
  // Evaluation

  private test(c: VrcCondition): boolean {
    const v = this.get(c.parameter);
    const th = Number(c.threshold) || 0;
    switch (c.mode) {
      case 'if': return v !== 0;
      case 'ifNot': return v === 0;
      case 'greater': return v > th;
      case 'less': return v < th;
      case 'equals': return Math.abs(v - th) < 1e-4;
      case 'notEqual': return Math.abs(v - th) >= 1e-4;
      default: return false;
    }
  }

  /** The state whose incoming transition conditions hold (most specific first), else the default state. */
  activeState(layer: VrcLayer): VrcState | null {
    let best: VrcState | null = null;
    let score = 0;
    for (const s of layer.states || []) {
      for (const conj of s.when || []) {
        if (conj.length > score && conj.every((c) => this.test(c))) { best = s; score = conj.length; }
      }
    }
    return best || (layer.states || []).find((s) => s.default) || null;
  }

  private evalMotion(m: VrcMotion | null | undefined, w: number, acc: Acc, depth = 0) {
    if (!m || w <= 0 || depth > 16) return;
    if ('blend' in m) {
      const kids = (m.children || []).slice().sort((a, b) => a.threshold - b.threshold);
      if (!kids.length) return;
      const v = this.get(m.blend);
      if (v <= kids[0].threshold) return this.evalMotion(kids[0].motion, w, acc, depth + 1);
      const last = kids[kids.length - 1];
      if (v >= last.threshold) return this.evalMotion(last.motion, w, acc, depth + 1);
      for (let i = 0; i < kids.length - 1; i++) {
        const a = kids[i], b = kids[i + 1];
        if (v < a.threshold || v > b.threshold) continue;
        const span = b.threshold - a.threshold;
        const t = span > 0 ? (v - a.threshold) / span : 0;
        this.evalMotion(a.motion, w * (1 - t), acc, depth + 1);
        this.evalMotion(b.motion, w * t, acc, depth + 1);
        return;
      }
      return;
    }
    if ('direct' in m) {
      for (const c of m.direct || []) this.evalMotion(c.motion, w * Math.max(0, this.get(c.parameter)), acc, depth + 1);
      return;
    }
    for (const s of m.blendShapes || []) {
      const id = `${s.path}\u0000${s.shape}`;
      acc.shapes.set(id, (acc.shapes.get(id) || 0) + s.weight * w);
    }
    for (const o of m.objects || []) {
      const cur = acc.objects.get(o.path) || [0, 0];
      cur[0] += (o.active ? 1 : 0) * w;
      cur[1] += w;
      acc.objects.set(o.path, cur);
    }
  }

  /** Re-evaluates every toggle layer and pushes the result to the avatar. */
  apply() {
    const morphs = new Map<string, number>();
    const objects = new Map<THREE.Object3D, boolean>();
    const d = this.meta.defaults || {};
    for (const s of d.blendShapes || []) for (const k of this.morphKeys(s.path, s.shape)) morphs.set(k, s.weight);
    for (const o of d.objects || []) { const n = this.node(o.path); if (n) objects.set(n, !!o.active); }

    for (const layer of this.meta.toggles || []) {
      const state = this.activeState(layer);
      if (!state?.motion) continue;
      const acc: Acc = { shapes: new Map(), objects: new Map() };
      this.evalMotion(state.motion, 1, acc);
      for (const [id, v] of acc.shapes) {
        const [path, shape] = id.split('\u0000');
        // Explicit zeros are kept so an FX state can switch off a blendshape set in the scene.
        for (const k of this.morphKeys(path, shape)) morphs.set(k, v);
      }
      for (const [path, [sum, total]] of acc.objects) {
        const n = this.node(path);
        if (n && total > 0) objects.set(n, sum / total >= 0.5);
      }
    }
    this.avatar.setLayer('vrc-fx', morphs);
    this.fxObjects = objects;
    this.applyVisibility();
  }

  private applyVisibility() {
    const want = new Map(this.fxObjects);
    for (const [n, v] of this.overlay) want.set(n, v);
    for (const n of this.touched) if (!want.has(n)) n.visible = true;
    for (const [n, v] of want) n.visible = v;
    this.touched = new Set(want.keys());
  }

  dispose() {
    this.avatar.clearLayer('vrc-fx');
    for (const n of this.touched) n.visible = true;
    this.touched.clear();
  }
}
