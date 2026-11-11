// The lower body of the desktop character motion. Motions describe it with a few numbers (BodyKeys): the
// hips moved and turned, the weight on one leg or the other, knees bent, heels up, a foot moved or turned.
// LegRig turns that into a pose the way a person's legs follow the upper body: the hips go where they are
// told (and lower themselves when a leg would not reach), and each leg is solved with two-bone IK so the
// feet stay where they stand, or step, or rise on the toes.
import * as THREE from 'three';
import type { Avatar } from '../avatar';
import type { BoneWriter } from './bones';

export interface FootKeys {
  /** moved, metres (x + = the avatar's left, y + = up, z + = forward) */
  x?: number; y?: number; z?: number;
  /** toes turned, degrees (+ = toward the avatar's left) */
  yaw?: number;
  /** heel up, degrees (standing on the ball of the foot) */
  heel?: number;
}

export interface BodyKeys {
  /** hips moved, metres (x + = the avatar's left, y + = up, z + = forward) */
  x?: number; y?: number; z?: number;
  /** hips turned, degrees: yaw + = toward the avatar's left, pitch + = forward, roll + = toward its right */
  yaw?: number; pitch?: number; roll?: number;
  /** weight on the right leg (1) … on the left one (-1); mixed with the idle weight by the motion's strength */
  weight?: number;
  /** knees bent, degrees: the hips go down by as much */
  bob?: number;
  /** both heels up, 0..1: on the toes */
  rise?: number;
  /** knees turned in, degrees */
  kneesIn?: number;
  right?: FootKeys;
  left?: FootKeys;
}

type Foot = { x: number; y: number; z: number; yaw: number; heel: number };
const foot = (): Foot => ({ x: 0, y: 0, z: 0, yaw: 0, heel: 0 });

/** The lower-body keys of everything playing, each taken by its strength. */
export class Body {
  x = 0; y = 0; z = 0; yaw = 0; pitch = 0; roll = 0; bob = 0; rise = 0; kneesIn = 0;
  /** How far the feet stand apart beyond the avatar's own pose (metres, each foot): the hips travel further over a foot */
  width = 0;
  right = foot();
  left = foot();
  private weightSum = 0;
  private weightAmount = 0;

  reset() {
    this.x = this.y = this.z = this.yaw = this.pitch = this.roll = this.bob = this.rise = this.kneesIn = this.width = 0;
    this.right = foot();
    this.left = foot();
    this.weightSum = this.weightAmount = 0;
    return this;
  }

  add(k: BodyKeys | null | undefined, w: number) {
    if (!k || w <= 0) return;
    this.x += (k.x || 0) * w; this.y += (k.y || 0) * w; this.z += (k.z || 0) * w;
    this.yaw += (k.yaw || 0) * w; this.pitch += (k.pitch || 0) * w; this.roll += (k.roll || 0) * w;
    this.bob += (k.bob || 0) * w; this.rise = Math.max(this.rise, (k.rise || 0) * w);
    this.kneesIn += (k.kneesIn || 0) * w;
    for (const side of ['right', 'left'] as const) {
      const f = k[side];
      if (!f) continue;
      const o = this[side];
      o.x += (f.x || 0) * w; o.y += (f.y || 0) * w; o.z += (f.z || 0) * w;
      o.yaw += (f.yaw || 0) * w; o.heel += (f.heel || 0) * w;
    }
    if (k.weight !== undefined) { this.weightSum += k.weight * w; this.weightAmount += w; }
  }

  /** Weight on the right leg: the idle one, taken over by the motions' as far as they ask for it. */
  weight(idle: number) {
    const a = Math.min(1, this.weightAmount);
    return a > 0 ? idle * (1 - a) + (this.weightSum / this.weightAmount) * a : idle;
  }

  /** Everything scaled (the lower body taken down while the broadcast runs). */
  scale(s: number, feet: number) {
    this.x *= s; this.y *= s; this.z *= s; this.yaw *= s; this.pitch *= s; this.roll *= s;
    this.bob *= s; this.rise *= s; this.kneesIn *= s;
    for (const o of [this.right, this.left]) { o.x *= feet; o.y *= feet; o.z *= feet; o.yaw *= feet; o.heel *= s; }
  }
}

const DEG = Math.PI / 180;
const v = () => new THREE.Vector3();

interface Planted {
  ankle: THREE.Vector3;
  ball: THREE.Vector3;
  foot: THREE.Quaternion;
  toes: THREE.Quaternion;
  hasToes: boolean;
}

// Scratch values: t* for apply / footTarget, s* for solveLeg, a* for aim (they call each other).
const tA = v(), tB = v(), tC = v(), tD = v(), tE = v(), tF = v();
const sHip = v(), sKnee = v(), sAnkle = v(), sTo = v(), sSide = v(), sDir = v(), sA = v(), sB = v();
const aA = v(), aB = v(), aC = v(), aD = v(), aE = v(), aF = v();
const qA = new THREE.Quaternion(), qB = new THREE.Quaternion(), qC = new THREE.Quaternion(), qD = new THREE.Quaternion();
const mA = new THREE.Matrix4(), mB = new THREE.Matrix4();

export class LegRig {
  private planted: Record<'right' | 'left', Planted> = {
    right: { ankle: v(), ball: v(), foot: new THREE.Quaternion(), toes: new THREE.Quaternion(), hasToes: false },
    left: { ankle: v(), ball: v(), foot: new THREE.Quaternion(), toes: new THREE.Quaternion(), hasToes: false },
  };
  private ok = false;
  // the avatar's directions in the world, and its scale
  private fwd = v();
  private left = v();
  private up = v();
  private scale = 1;
  private zSign = 1;

  /** Where the feet stand in the pose from before the motion (call before anything moves this frame). */
  plant(a: Avatar) {
    this.ok = false;
    const hips = a.normalizedBone('hips');
    const root = hips?.parent;
    if (!hips || !root) return;
    this.zSign = a.metaVersion === '0' ? -1 : 1;
    root.getWorldQuaternion(qA);
    this.fwd.set(0, 0, this.zSign).applyQuaternion(qA);
    this.left.set(this.zSign, 0, 0).applyQuaternion(qA);
    this.up.set(0, 1, 0).applyQuaternion(qA);
    this.scale = root.getWorldScale(tA).y || 1;
    for (const side of ['right', 'left'] as const) {
      const f = a.normalizedBone(`${side}Foot`), toes = a.normalizedBone(`${side}Toes`);
      const up = a.normalizedBone(`${side}UpperLeg`), low = a.normalizedBone(`${side}LowerLeg`);
      if (!f || !up || !low) return;
      const p = this.planted[side];
      f.getWorldPosition(p.ankle);
      f.getWorldQuaternion(p.foot);
      p.hasToes = !!toes;
      if (toes) {
        toes.getWorldPosition(p.ball);
        toes.getWorldQuaternion(p.toes);
      } else {
        // No toe bone: the ball of the foot a little in front of and below the ankle.
        const len = up.getWorldPosition(tA).distanceTo(f.getWorldPosition(tB)) * 0.3;
        p.ball.copy(p.ankle).addScaledVector(this.fwd, len).addScaledVector(this.up, -len * 0.45);
      }
    }
    this.ok = true;
  }

  /**
   * Moves the hips by the body keys and solves both legs. weight: on the right leg (1) … left (-1).
   * Returns false when the avatar has no legs to solve.
   */
  apply(a: Avatar, bones: BoneWriter, body: Body, weight: number): boolean {
    if (!this.ok) return false;
    const hips = a.normalizedBone('hips')!;
    const s = this.scale;
    const legs = (['right', 'left'] as const).map((side) => ({
      side,
      sign: side === 'right' ? 1 : -1,
      up: a.normalizedBone(`${side}UpperLeg`)!,
      low: a.normalizedBone(`${side}LowerLeg`)!,
      foot: a.normalizedBone(`${side}Foot`)!,
      toes: a.normalizedBone(`${side}Toes`),
      keys: body[side],
    }));
    const thigh = legs[0].up.getWorldPosition(tA).distanceTo(legs[0].low.getWorldPosition(tB));
    const shin = tB.distanceTo(legs[0].foot.getWorldPosition(tC));

    // Standing on one leg (contrapposto): the hips go over it (further when the feet are apart) and drop
    // on the other side, whose heel comes up a little so that knee bends forward.
    const hx = body.x - (0.022 + 0.45 * Math.max(0, body.width)) * weight;
    const roll = body.roll - 2.2 * weight;
    // Knees bent: the hips go down by as much as the legs get shorter.
    const bend = Math.max(0, body.bob) * DEG;
    const drop = ((thigh + shin) / s) * (1 - Math.cos(bend));
    // On the toes: up by as much as the lower heel lifts the ankles.
    const heels = { right: body.right.heel + body.rise * 22 + 5 * Math.max(0, -weight), left: body.left.heel + body.rise * 22 + 5 * Math.max(0, weight) };
    const footLen = (side: 'right' | 'left') => this.planted[side].ankle.distanceTo(this.planted[side].ball) / s;
    const lift = Math.min(footLen('right') * Math.sin(Math.max(0, body.rise * 22 * DEG)), footLen('left') * Math.sin(Math.max(0, body.rise * 22 * DEG)));
    bones.shift(hips, hx, body.y - drop + lift, body.z);
    bones.offset(hips, body.pitch * DEG, body.yaw * DEG, roll * DEG);

    // Where each ankle goes, and how the foot and toes turn.
    const targets = legs.map((l) => this.footTarget(l.side, l.keys, heels[l.side]));
    // Lower the hips when a leg would not reach (moving the hips sideways or forward also lowers them).
    let need = 0;
    for (let i = 0; i < 2; i++) {
      const hipJoint = legs[i].up.getWorldPosition(tA);
      const len = (legs[i].up.getWorldPosition(tB).distanceTo(legs[i].low.getWorldPosition(tC)) + tC.distanceTo(legs[i].foot.getWorldPosition(tD))) * 0.998;
      const d = tE.subVectors(targets[i].ankle, hipJoint);
      const dl = d.length();
      if (dl > len) {
        const du = d.dot(this.up);
        const disc = du * du - dl * dl + len * len;
        need = Math.max(need, disc > 0 ? -du - Math.sqrt(disc) : dl - len);
      }
    }
    if (need > 0) bones.shift(hips, 0, -need / s, 0);

    for (let i = 0; i < 2; i++) {
      const l = legs[i];
      // Knees point where the toes do, a little outward, and follow the hips' turn.
      const turn = (l.keys.yaw + body.yaw * 0.5 + l.sign * (body.kneesIn - 5)) * DEG;
      const pole = tF.copy(this.fwd).applyAxisAngle(this.up, turn);
      this.solveLeg(bones, l.up, l.low, l.foot, l.toes, targets[i], pole);
    }
    return true;
  }

  private footTarget(side: 'right' | 'left', k: Foot, heelDeg: number) {
    const p = this.planted[side];
    const heel = Math.max(0, heelDeg) * DEG;
    // Heel up around the ball of the foot.
    const rh = qA.setFromAxisAngle(this.left, heel);
    const ankle = tB.subVectors(p.ankle, p.ball).applyQuaternion(rh).add(p.ball);
    // Toes turned around the heel, or around the ball when the heel is up.
    const pivotK = Math.min(1, heelDeg / 8);
    const pivot = tC.copy(p.ankle).lerp(p.ball, Math.max(0, pivotK));
    const ry = qB.setFromAxisAngle(this.up, k.yaw * DEG);
    ankle.sub(pivot).applyQuaternion(ry).add(pivot);
    // Moved.
    ankle.addScaledVector(this.left, k.x * this.scale).addScaledVector(this.up, k.y * this.scale).addScaledVector(this.fwd, k.z * this.scale);
    return {
      ankle: ankle.clone(),
      foot: qC.copy(ry).multiply(rh).multiply(p.foot).clone(),
      toes: p.hasToes ? ry.clone().multiply(p.toes) : null,
    };
  }

  /** Two-bone IK: thigh and shin reach for the ankle target, the knee toward the pole; then foot and toes. */
  private solveLeg(bones: BoneWriter, up: THREE.Object3D, low: THREE.Object3D, footNode: THREE.Object3D, toes: THREE.Object3D | null,
    t: { ankle: THREE.Vector3; foot: THREE.Quaternion; toes: THREE.Quaternion | null }, pole: THREE.Vector3) {
    const hip = up.getWorldPosition(sHip);
    const l1 = hip.distanceTo(low.getWorldPosition(sA));
    const l2 = sA.distanceTo(footNode.getWorldPosition(sB));
    const toT = sTo.subVectors(t.ankle, hip);
    const d = THREE.MathUtils.clamp(toT.length(), Math.abs(l1 - l2) + 1e-4, (l1 + l2) * 0.9995);
    const u = toT.normalize();
    const cosA = THREE.MathUtils.clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
    const sinA = Math.sqrt(1 - cosA * cosA);
    const side = sSide.copy(pole).addScaledVector(u, -pole.dot(u));
    if (side.lengthSq() < 1e-8) side.copy(this.fwd).addScaledVector(u, -this.fwd.dot(u));
    side.normalize();
    const knee = sKnee.copy(hip).addScaledVector(u, l1 * cosA).addScaledVector(side, l1 * sinA);
    const ankle = sAnkle.copy(hip).addScaledVector(u, d);
    this.aim(bones, up, low.position, sDir.subVectors(knee, hip), pole);
    this.aim(bones, low, footNode.position, sDir.subVectors(ankle, knee), pole);
    low.getWorldQuaternion(qD);
    bones.set(footNode, qD.invert().multiply(t.foot));
    if (toes && t.toes) {
      footNode.getWorldQuaternion(qD);
      bones.set(toes, qD.invert().multiply(t.toes));
    }
  }

  /**
   * Turns a bone so that its child (at childPos in its own space) lies along dirW, its forward side
   * toward the pole: the rest frame (bone direction, forward) mapped onto the wanted one.
   */
  private aim(bones: BoneWriter, node: THREE.Object3D, childPos: THREE.Vector3, dirW: THREE.Vector3, pole: THREE.Vector3) {
    const a = aA.copy(childPos).normalize();
    const b = aB.set(0, 0, this.zSign);
    b.addScaledVector(a, -b.dot(a)).normalize();
    const c = aC.crossVectors(a, b);
    mA.makeBasis(a, b, c).transpose();
    const a2 = aD.copy(dirW).normalize();
    const b2 = aE.copy(pole).addScaledVector(a2, -pole.dot(a2));
    if (b2.lengthSq() < 1e-8) b2.copy(this.fwd).addScaledVector(a2, -this.fwd.dot(a2));
    b2.normalize();
    const c2 = aF.crossVectors(a2, b2);
    mB.makeBasis(a2, b2, c2).multiply(mA);
    qB.setFromRotationMatrix(mB);
    node.parent!.getWorldQuaternion(qC);
    bones.set(node, qC.invert().multiply(qB));
  }
}
