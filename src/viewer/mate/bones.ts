// Writes the desktop character motion onto normalized humanoid bones so it can be taken off exactly: each changed bone
// keeps its pose from before (base) and what was written (written). At the start of the next frame a bone
// that still holds what was written gets its base back, so motions, the VRChat animator and cursor gaze
// see their own pose again and keep working as without it.
// Angles are degrees on the normalized (T-pose) bones of an avatar facing +Z: x pitches (+ = forward /
// down), y turns (+ = toward the avatar's left; on the right arm: forward), z rolls (+ = toward the
// avatar's right; on the right arm: down). The left side mirrors the right: y and z change sign.
import * as THREE from 'three';
import type { VRMHumanBoneName } from '@pixiv/three-vrm';
import { convertForModel } from '../avatar';

type Axis = 'x' | 'y' | 'z';
/** Rotations applied one after another (the first one first). */
export type Steps = [Axis, number][];

export interface BoneMove {
  /** add: on top of the current pose, scaled by the weight; pose: toward this rotation (from T-pose) */
  mode: 'add' | 'pose';
  steps: Steps;
  /** How much of it (0..1), when only this bone eases in or out within a motion */
  w?: number;
}

export type Frame = Partial<Record<VRMHumanBoneName, BoneMove>>;

export const add = (...steps: Steps): BoneMove => ({ mode: 'add', steps });
export const pose = (...steps: Steps): BoneMove => ({ mode: 'pose', steps });
/** The move at part strength (0..1). */
export const part = (m: BoneMove, w: number): BoneMove => ({ ...m, w: (m.w ?? 1) * w });
/** The same move on the other side (y and z change sign). */
export const flip = (m: BoneMove): BoneMove => ({ ...m, steps: m.steps.map(([ax, d]) => [ax, ax === 'x' ? d : -d]) });

/** The right side's moves copied to the left (mirrored), for poses with both arms. */
export function mirrored(f: Frame): Frame {
  const out: Frame = { ...f };
  for (const [bone, m] of Object.entries(f) as [VRMHumanBoneName, BoneMove][]) {
    if (!bone.startsWith('right')) continue;
    const left = ('left' + bone.slice(5)) as VRMHumanBoneName;
    if (!out[left]) out[left] = flip(m);
  }
  return out;
}

interface Saved { base: THREE.Quaternion; written: THREE.Quaternion; pos?: { base: THREE.Vector3; written: THREE.Vector3 } }

const AXES = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
const DEG = Math.PI / 180;
const q = new THREE.Quaternion();
const delta = new THREE.Quaternion();
const stepQ = new THREE.Quaternion();
const euler = new THREE.Euler(0, 0, 0, 'YXZ');

export class BoneWriter {
  private saved = new Map<THREE.Object3D, Saved>();
  metaVersion: '0' | '1' = '1';

  get touched() {
    return this.saved.size > 0;
  }

  /** Start of the frame, before anything poses the bones: the pose without our motion again. */
  restore() {
    for (const [node, s] of this.saved) {
      // Unchanged since we wrote it: back to the exact pose before our motion.
      if (node.quaternion.equals(s.written)) node.quaternion.copy(s.base);
      if (s.pos && node.position.equals(s.pos.written)) node.position.copy(s.pos.base);
    }
    this.saved.clear();
  }

  /** End of our part of the frame: remembers what we wrote, so restore() can tell whether anything else changed it. */
  seal() {
    for (const [node, s] of this.saved) {
      s.written.copy(node.quaternion);
      s.pos?.written.copy(node.position);
    }
  }

  /** Forgets the bones without touching them (another avatar was loaded). */
  forget() {
    this.saved.clear();
  }

  private touch(node: THREE.Object3D) {
    let s = this.saved.get(node);
    if (!s) { s = { base: node.quaternion.clone(), written: new THREE.Quaternion() }; this.saved.set(node, s); }
    return s;
  }

  /** Small rotation (radians, applied y → x → z) on top of the bone's pose this frame. */
  offset(node: THREE.Object3D, x: number, y: number, z: number) {
    if (!x && !y && !z) return;
    this.touch(node);
    euler.set(x, y, z, 'YXZ');
    convertForModel(q.setFromEuler(euler), this.metaVersion, delta);
    node.quaternion.multiply(delta);
  }

  /** An added rotation scaled by the weight, or a blend toward a pose (weight 0..1). */
  move(node: THREE.Object3D, m: BoneMove, weight: number) {
    weight *= m.w ?? 1;
    if (weight <= 0) return;
    this.touch(node);
    const scale = m.mode === 'add' ? weight : 1;
    q.identity();
    for (const [axis, deg] of m.steps) q.premultiply(stepQ.setFromAxisAngle(AXES[axis], deg * DEG * scale));
    convertForModel(q, this.metaVersion, delta);
    if (m.mode === 'add') node.quaternion.multiply(delta);
    else node.quaternion.slerp(delta, Math.min(1, weight));
  }

  /** Sets the bone's rotation outright (legs worked out by IK), in its parent's space. */
  set(node: THREE.Object3D, q: THREE.Quaternion) {
    this.touch(node);
    node.quaternion.copy(q);
  }

  /** Moves the bone (the hips) by a small distance in its parent's space. */
  shift(node: THREE.Object3D, x: number, y: number, z: number) {
    if (!x && !y && !z) return;
    const s = this.touch(node);
    if (!s.pos) s.pos = { base: node.position.clone(), written: new THREE.Vector3() };
    // VRM 0 models are turned around inside their normalized rig.
    if (this.metaVersion === '0') { x = -x; z = -z; }
    node.position.x += x; node.position.y += y; node.position.z += z;
  }
}
