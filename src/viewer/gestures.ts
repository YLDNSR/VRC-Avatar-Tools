// Hand gestures (VRChat GestureLeft / GestureRight 0..7) with finger poses and expressions.
import * as THREE from 'three';
import type { Avatar } from './avatar';
import type { VrcRuntime } from './vrcMeta';
import { VrcAnimator } from './vrcAnimator';
import { convertForModel } from './avatar';
import { fingerBones } from '../shared/bones';

// curl degrees per finger [seg1, seg2, seg3]; thumb uses its own axis. spread: degrees toward the thumb side.
interface FingerPose { curl: [number, number, number]; spread?: number }
type HandPose = [FingerPose, FingerPose, FingerPose, FingerPose, FingerPose]; // thumb, index, middle, ring, little

const FIST: FingerPose = { curl: [80, 100, 65] };
const STRAIGHT: FingerPose = { curl: [0, 0, 0] };
const THUMB_IN: FingerPose = { curl: [25, 35, 35], spread: -10 };
const THUMB_OUT: FingerPose = { curl: [-15, 0, 0], spread: 25 };

export const HAND_POSES: (HandPose | null)[] = [
  null, // 0 Neutral: leave fingers to animation / tracking
  [{ curl: [35, 45, 40], spread: -15 }, FIST, FIST, FIST, FIST], // 1 Fist
  [{ curl: [-5, 0, 0], spread: 25 }, { curl: [-5, 0, 0], spread: 12 }, { curl: [-5, 0, 0], spread: 3 }, { curl: [-5, 0, 0], spread: -6 }, { curl: [-5, 0, 0], spread: -15 }], // 2 HandOpen
  [THUMB_IN, STRAIGHT, FIST, FIST, FIST], // 3 FingerPoint
  [THUMB_IN, { curl: [0, 0, 0], spread: 9 }, { curl: [0, 0, 0], spread: -6 }, FIST, FIST], // 4 Victory
  [THUMB_IN, STRAIGHT, FIST, FIST, { curl: [0, 0, 0], spread: -12 }], // 5 RockNRoll
  [THUMB_OUT, STRAIGHT, FIST, FIST, FIST], // 6 HandGun
  [{ curl: [-35, -5, 0], spread: 15 }, FIST, FIST, FIST, FIST], // 7 ThumbsUp
];

/** Default gesture → VRM expression mapping (VRM avatars have 5 emotion presets: F2–F6). */
export const VRM_GESTURE_EXPRESSIONS: (string | null)[] = [null, 'happy', 'angry', 'sad', 'relaxed', 'surprised', null, null];

const AX = new THREE.Vector3(1, 0, 0);
const AY = new THREE.Vector3(0, 1, 0);
const AZ = new THREE.Vector3(0, 0, 1);
const qa = new THREE.Quaternion();
const qb = new THREE.Quaternion();
const qc = new THREE.Quaternion();

function fingerRotation(side: 'left' | 'right', finger: number, seg: number, pose: FingerPose, out: THREE.Quaternion) {
  const s = side === 'left' ? 1 : -1;
  const curl = THREE.MathUtils.degToRad(pose.curl[seg]);
  const spread = seg === 0 ? THREE.MathUtils.degToRad(pose.spread || 0) : 0;
  if (finger === 0) {
    // Thumb: fold under the palm about X, spread about Y.
    qa.setFromAxisAngle(AX, curl);
    qb.setFromAxisAngle(AY, -s * spread);
    return out.copy(qb).multiply(qa);
  }
  qa.setFromAxisAngle(AZ, -s * curl);
  qb.setFromAxisAngle(AY, -s * spread);
  return out.copy(qb).multiply(qa);
}

export class GestureController {
  left = 0;
  right = 0;
  lastSide: 'left' | 'right' = 'left';
  /** per-avatar overrides: gesture index → expression name */
  expressionMap: (string | null)[] = VRM_GESTURE_EXPRESSIONS.slice();
  /** VRChat sidecar; a v1 gesture map replaces expressionMap, a v2 animator gets GestureLeft/Right. */
  vrc: VrcRuntime | null = null;
  private blend = { left: 0, right: 0 };
  private exprWeights = new Map<string, number>();
  private state = new Map<string, THREE.Quaternion>();
  onChange?: (side: 'left' | 'right', index: number) => void;

  set(side: 'left' | 'right', index: number, toggle = true) {
    const cur = side === 'left' ? this.left : this.right;
    const next = toggle && cur === index ? 0 : index;
    if (side === 'left') this.left = next; else this.right = next;
    if (next !== 0) this.lastSide = side;
    this.onChange?.(side, next);
  }

  reset() {
    this.left = 0;
    this.right = 0;
    this.state.clear();
    this.exprWeights.clear();
    this.blend.left = 0;
    this.blend.right = 0;
  }

  /**
   * Applies finger poses (unless tracking drives the fingers) and the expression layer.
   */
  update(avatar: Avatar, dt: number, fingersTracked: { left: boolean; right: boolean }) {
    const k = 1 - Math.exp(-dt * 18);
    for (const side of ['left', 'right'] as const) {
      const g = side === 'left' ? this.left : this.right;
      const pose = HAND_POSES[g];
      this.blend[side] += ((pose ? 1 : 0) - this.blend[side]) * k;
      if (fingersTracked[side] || !avatar.humanoid) continue;
      if (!pose && this.blend[side] < 0.002) continue;
      const chains = fingerBones(side);
      for (let f = 0; f < 5; f++) {
        for (let seg = 0; seg < 3; seg++) {
          const node = avatar.normalizedBone(chains[f][seg]);
          if (!node) continue;
          if (pose) {
            fingerRotation(side, f, seg, pose[f], qc);
            convertForModel(qc, avatar.metaVersion, qc);
          } else {
            qc.identity(); // fading back to the rest pose
          }
          let st = this.state.get(chains[f][seg]);
          if (!st) { st = node.quaternion.clone(); this.state.set(chains[f][seg], st); }
          st.slerp(qc, k);
          if (pose) node.quaternion.copy(st);
          else node.quaternion.slerp(st, this.blend[side]);
        }
      }
    }

    // Sidecar v2: the avatar's own FX / Gesture layers react to GestureLeft / GestureRight.
    if (this.vrc instanceof VrcAnimator) {
      this.vrc.setGesture(this.left, this.right);
      avatar.clearLayer('gesture');
      return;
    }

    // Expression: the most recently changed hand wins, the other hand is the fallback.
    const primary = this.lastSide === 'left' ? this.left : this.right;
    const secondary = this.lastSide === 'left' ? this.right : this.left;
    const fx = this.vrc && !(this.vrc instanceof VrcAnimator) && this.vrc.hasGestures ? this.vrc : null;
    let exprName: string | null;
    if (fx) {
      // FX gesture map: names are "left:3" / "right:1" (no VRM fallback, like VRChat).
      const other = this.lastSide === 'left' ? 'right' : 'left';
      exprName = fx.gesture(this.lastSide, primary) ? `${this.lastSide}:${primary}` : fx.gesture(other, secondary) ? `${other}:${secondary}` : null;
    } else {
      exprName = this.expressionMap[primary] || this.expressionMap[secondary] || null;
    }
    for (const name of new Set([...this.exprWeights.keys(), ...(exprName ? [exprName] : [])])) {
      const target = name === exprName ? 1 : 0;
      const w = (this.exprWeights.get(name) || 0) + (target - (this.exprWeights.get(name) || 0)) * k;
      if (w < 0.001 && target === 0) this.exprWeights.delete(name);
      else this.exprWeights.set(name, w);
    }
    const layer = new Map<string, number>();
    const objects = new Map<THREE.Object3D, boolean>();
    for (const [name, w] of this.exprWeights) {
      const sep = name.indexOf(':');
      const effect = fx && sep > 0 ? fx.gesture(name.slice(0, sep) as 'left' | 'right', Number(name.slice(sep + 1))) : null;
      if (effect) {
        for (const [key, v] of effect.morphs) layer.set(key, Math.max(layer.get(key) || 0, v * w));
        if (w > 0.5) for (const [node, active] of effect.objects) objects.set(node, active);
      } else if (sep < 0) {
        for (const key of avatar.resolveExpression(name)) layer.set(key, w);
      }
    }
    avatar.setLayer('gesture', layer);
    fx?.setGestureObjects(objects);
  }

  isActive() {
    return this.left !== 0 || this.right !== 0 || this.exprWeights.size > 0;
  }
}
