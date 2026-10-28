// Converts MediaPipe landmarks into VRM normalized bone rotations (avatar faces +Z, avatar left = +X).
import * as THREE from 'three';
import { PointsFilter } from './filters';

export interface LM { x: number; y: number; z: number; visibility?: number }

export interface SolveOptions {
  mirror: boolean;
  lowerBody: boolean;
  upper: { stability: number; responsiveness: number; amount: number };
  arm: { stability: number; responsiveness: number; amount: number };
  handDepth: number; // -1..1
}

export interface HandObs {
  world: LM[];
  image: LM[];
  label: string; // MediaPipe handedness label
}

export interface SolveResult {
  bones: Map<string, THREE.Quaternion>;
  bodyValid: boolean;
  armsValid: { left: boolean; right: boolean };
  handsValid: { left: boolean; right: boolean };
}

const MIRROR_PAIRS: [number, number][] = [[1, 4], [2, 5], [3, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16], [17, 18], [19, 20], [21, 22], [23, 24], [25, 26], [27, 28], [29, 30], [31, 32]];
const MIRROR_MAP = Array.from({ length: 33 }, (_, i) => i);
for (const [a, b] of MIRROR_PAIRS) { MIRROR_MAP[a] = b; MIRROR_MAP[b] = a; }

const I = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();

/** Rotation that maps the rest frame (restDir, restAxis) onto (dir, axis). */
export function frameRotation(restDir: THREE.Vector3, restAxis: THREE.Vector3, dir: THREE.Vector3, axis: THREE.Vector3, out = new THREE.Quaternion()) {
  const d = dir.clone().normalize();
  const a = axis.clone().sub(d.clone().multiplyScalar(axis.dot(d))).normalize();
  const c = new THREE.Vector3().crossVectors(d, a);
  const rd = restDir.clone().normalize();
  const ra = restAxis.clone().sub(rd.clone().multiplyScalar(restAxis.dot(rd))).normalize();
  const rc = new THREE.Vector3().crossVectors(rd, ra);
  _m.makeBasis(d, a, c);
  _m2.makeBasis(rd, ra, rc).transpose();
  _m.multiply(_m2);
  return out.setFromRotationMatrix(_m);
}

function v(lm: LM | undefined, out = new THREE.Vector3()) {
  return lm ? out.set(lm.x, lm.y, lm.z) : out.set(0, 0, 0);
}

export class BodySolver {
  private upperFilter = new PointsFilter();
  private armFilter = new PointsFilter();
  private legFilter = new PointsFilter();
  private handFilters = { left: new PointsFilter(), right: new PointsFilter() };
  private armWeight = { left: 0, right: 0 };
  /** calibration: inverse neutral rotations */
  calib: { chest: THREE.Quaternion; hips: THREE.Quaternion } | null = null;
  private lastChest = new THREE.Quaternion();
  private lastHips = new THREE.Quaternion();

  configure(o: SolveOptions) {
    this.upperFilter.configure(o.upper.stability, o.upper.responsiveness);
    this.legFilter.configure(o.upper.stability, o.upper.responsiveness);
    this.armFilter.configure(o.arm.stability, o.arm.responsiveness);
    this.handFilters.left.configure(o.arm.stability * 0.8, o.arm.responsiveness);
    this.handFilters.right.configure(o.arm.stability * 0.8, o.arm.responsiveness);
  }

  calibrate() {
    this.calib = { chest: this.lastChest.clone().invert(), hips: this.lastHips.clone().invert() };
  }

  /** World landmarks → avatar space (with optional mirroring). */
  private toAvatar(world: LM[], image: LM[] | null, mirror: boolean) {
    const pts: THREE.Vector3[] = [];
    const vis: number[] = [];
    for (let i = 0; i < 33; i++) {
      const src = mirror ? MIRROR_MAP[i] : i;
      const w = world[src];
      pts.push(w ? new THREE.Vector3(mirror ? -w.x : w.x, -w.y, -w.z) : new THREE.Vector3());
      vis.push(image?.[src]?.visibility ?? w?.visibility ?? 1);
    }
    return { pts, vis };
  }

  solve(world: LM[] | null, image: LM[] | null, hands: HandObs[], o: SolveOptions, dt: number): SolveResult {
    const bones = new Map<string, THREE.Quaternion>();
    const res: SolveResult = { bones, bodyValid: false, armsValid: { left: false, right: false }, handsValid: { left: false, right: false } };
    if (!world || world.length < 33) return res;
    const { pts, vis } = this.toAvatar(world, image, o.mirror);

    // Filter groups of points
    const flat = (idx: number[]) => idx.flatMap((i) => [pts[i].x, pts[i].y, pts[i].z]);
    const unflat = (idx: number[], arr: number[]) => idx.forEach((i, k) => pts[i].set(arr[k * 3], arr[k * 3 + 1], arr[k * 3 + 2]));
    const upperIdx = [11, 12, 23, 24];
    const armIdx = [13, 14, 15, 16, 17, 18, 19, 20, 21, 22];
    const legIdx = [25, 26, 27, 28, 29, 30, 31, 32];
    unflat(upperIdx, this.upperFilter.apply(flat(upperIdx), dt));
    unflat(armIdx, this.armFilter.apply(flat(armIdx), dt));
    if (o.lowerBody) unflat(legIdx, this.legFilter.apply(flat(legIdx), dt));

    const shoulderVis = Math.min(vis[11], vis[12]);
    if (shoulderVis < 0.3) return res;
    res.bodyValid = true;

    // --- Torso
    const lSh = pts[11], rSh = pts[12], lHip = pts[23], rHip = pts[24];
    const shMid = lSh.clone().add(rSh).multiplyScalar(0.5);
    const hipMid = lHip.clone().add(rHip).multiplyScalar(0.5);
    const up = shMid.clone().sub(hipMid).normalize();
    const hipsVisible = Math.min(vis[23], vis[24]) > 0.5;
    const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);

    const chestWorld = frameRotation(X, Y, lSh.clone().sub(rSh), up);
    let hipsWorld = new THREE.Quaternion();
    if (hipsVisible) hipsWorld = frameRotation(X, Y, lHip.clone().sub(rHip), up);
    else hipsWorld.copy(chestWorld).slerp(I, 0.5);
    this.lastChest.copy(chestWorld);
    this.lastHips.copy(hipsWorld);
    if (this.calib) {
      chestWorld.premultiply(this.calib.chest);
      hipsWorld.premultiply(this.calib.hips);
    }
    if (!o.lowerBody) hipsWorld.identity();
    const amountU = o.upper.amount;
    const relChest = hipsWorld.clone().invert().multiply(chestWorld);
    const relScaled = I.clone().slerp(relChest, amountU);
    const spine = I.clone().slerp(relScaled, 0.5);
    const chest = spine.clone().invert().multiply(relScaled);
    bones.set('hips', I.clone().slerp(hipsWorld, amountU));
    bones.set('spine', spine);
    bones.set('chest', chest);
    const chestW = bones.get('hips')!.clone().multiply(spine).multiply(chest);

    // --- Arms
    for (const side of ['left', 'right'] as const) {
      const s = side === 'left' ? 1 : -1;
      const [iS, iE, iW, iP, iI] = side === 'left' ? [11, 13, 15, 17, 19] : [12, 14, 16, 18, 20];
      const visible = Math.min(vis[iE], vis[iW]) > 0.35;
      this.armWeight[side] += ((visible ? 1 : 0) - this.armWeight[side]) * Math.min(1, dt * 6);
      const restDir = new THREE.Vector3(s, 0, 0);
      const restAxis = new THREE.Vector3(0, -s, 0);
      // Arms-down pose used when the arm is not visible
      const down = new THREE.Quaternion().setFromAxisAngle(Z, -s * THREE.MathUtils.degToRad(72));
      let upperW = down.clone();
      let lowerW = down.clone();
      if (visible || this.armWeight[side] > 0.01) {
        const u = pts[iE].clone().sub(pts[iS]).normalize();
        const f = pts[iW].clone().sub(pts[iE]).normalize();
        const bend = new THREE.Vector3().crossVectors(u, f);
        const bendAmt = bend.length();
        const minimal = new THREE.Quaternion().setFromUnitVectors(restDir, u);
        let uw = minimal;
        if (bendAmt > 0.05) {
          const withAxis = frameRotation(restDir, restAxis, u, bend.normalize());
          uw = minimal.clone().slerp(withAxis, THREE.MathUtils.smoothstep(bendAmt, 0.08, 0.35));
        }
        // hand front/back adjustment: swing the arm around the vertical axis
        if (o.handDepth) uw.premultiply(new THREE.Quaternion().setFromAxisAngle(Y, -s * o.handDepth * THREE.MathUtils.degToRad(25)));
        const elbow = new THREE.Quaternion().setFromUnitVectors(u, f);
        const lw = elbow.multiply(uw);
        upperW = down.clone().slerp(uw, this.armWeight[side]);
        lowerW = down.clone().slerp(lw, this.armWeight[side]);
        res.armsValid[side] = visible;
      }
      // Hand orientation: hand landmarks if available, else pose pinky/index points
      let handW = lowerW.clone();
      const hand = hands.find((hh) => (hh as any).side === side);
      if (hand && hand.world.length === 21) {
        const hp = this.handPoints(hand, o.mirror, side, dt);
        const dir = hp[9].clone().sub(hp[0]);
        const cr = new THREE.Vector3().crossVectors(hp[5].clone().sub(hp[0]), hp[17].clone().sub(hp[0]));
        const palm = side === 'left' ? cr.negate() : cr;
        handW = frameRotation(restDir, new THREE.Vector3(0, -1, 0), dir, palm);
        res.handsValid[side] = true;
        this.solveFingers(hp, handW, side, bones);
      } else if (vis[iP] > 0.5 && vis[iI] > 0.5 && res.armsValid[side]) {
        const mid = pts[iP].clone().add(pts[iI]).multiplyScalar(0.5);
        const dir = mid.sub(pts[iW]);
        const cr = new THREE.Vector3().crossVectors(pts[iI].clone().sub(pts[iW]), pts[iP].clone().sub(pts[iW]));
        const palm = side === 'left' ? cr.negate() : cr;
        if (dir.lengthSq() > 1e-6 && palm.lengthSq() > 1e-8) handW = frameRotation(restDir, new THREE.Vector3(0, -1, 0), dir, palm);
      }
      handW = lowerW.clone().slerp(handW, this.armWeight[side]);

      const amountA = o.arm.amount;
      const upperL = chestW.clone().invert().multiply(upperW);
      const lowerL = upperW.clone().invert().multiply(lowerW);
      const handL = lowerW.clone().invert().multiply(handW);
      bones.set(`${side}UpperArm`, I.clone().slerp(upperL, amountA));
      bones.set(`${side}LowerArm`, I.clone().slerp(lowerL, amountA));
      bones.set(`${side}Hand`, I.clone().slerp(handL, amountA));
    }

    // --- Legs
    if (o.lowerBody) {
      const hipsW = bones.get('hips')!;
      for (const side of ['left', 'right'] as const) {
        const [iH, iK, iA, iT] = side === 'left' ? [23, 25, 27, 31] : [24, 26, 28, 32];
        if (Math.min(vis[iK], vis[iA]) < 0.5) {
          bones.set(`${side}UpperLeg`, hipsW.clone().invert());
          bones.set(`${side}LowerLeg`, I.clone());
          continue;
        }
        const u = pts[iK].clone().sub(pts[iH]).normalize();
        const f = pts[iA].clone().sub(pts[iK]).normalize();
        const restDir = new THREE.Vector3(0, -1, 0);
        const bend = new THREE.Vector3().crossVectors(u, f);
        let uw = new THREE.Quaternion().setFromUnitVectors(restDir, u);
        if (bend.length() > 0.05) uw = uw.slerp(frameRotation(restDir, X, u, bend.normalize()), THREE.MathUtils.smoothstep(bend.length(), 0.08, 0.3));
        const lw = new THREE.Quaternion().setFromUnitVectors(u, f).multiply(uw);
        bones.set(`${side}UpperLeg`, hipsW.clone().invert().multiply(uw));
        bones.set(`${side}LowerLeg`, uw.clone().invert().multiply(lw));
        if (vis[iT] > 0.5) {
          const footDir = pts[iT].clone().sub(pts[iA]);
          const fw = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -0.5, 1).normalize(), footDir.normalize());
          bones.set(`${side}Foot`, lw.clone().invert().multiply(fw));
        }
      }
    }
    return res;
  }

  private handPoints(hand: HandObs, mirror: boolean, side: 'left' | 'right', dt: number) {
    const raw = hand.world.flatMap((p) => [mirror ? -p.x : p.x, -p.y, -p.z]);
    const f = this.handFilters[side].apply(raw, dt);
    const out: THREE.Vector3[] = [];
    for (let i = 0; i < 21; i++) out.push(new THREE.Vector3(f[i * 3], f[i * 3 + 1], f[i * 3 + 2]));
    return out;
  }

  private solveFingers(hp: THREE.Vector3[], handW: THREE.Quaternion, side: 'left' | 'right', bones: Map<string, THREE.Quaternion>) {
    const s = side === 'left' ? 1 : -1;
    const chains: [string, number[], THREE.Vector3][] = [
      ['Thumb', [1, 2, 3, 4], new THREE.Vector3(s * 0.7, -0.2, 0.7).normalize()],
      ['Index', [5, 6, 7, 8], new THREE.Vector3(s, 0, 0)],
      ['Middle', [9, 10, 11, 12], new THREE.Vector3(s, 0, 0)],
      ['Ring', [13, 14, 15, 16], new THREE.Vector3(s, 0, 0)],
      ['Little', [17, 18, 19, 20], new THREE.Vector3(s, 0, 0)],
    ];
    for (const [name, idx, rest] of chains) {
      const segs = name === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal'];
      let parentW = handW.clone();
      for (let k = 0; k < 3; k++) {
        const d = hp[idx[k + 1]].clone().sub(hp[idx[k]]);
        if (d.lengthSq() < 1e-10) break;
        const local = d.normalize().applyQuaternion(parentW.clone().invert());
        let q = new THREE.Quaternion().setFromUnitVectors(rest, local);
        // fingers do not hyper-extend much; damp the sideways component on distal joints
        if (k > 0) q = I.clone().slerp(q, 0.9);
        bones.set(`${side}${name}${segs[k]}`, q);
        parentW = parentW.clone().multiply(q);
      }
    }
  }
}

/** Head rotation from MediaPipe's facial transformation matrix (avatar space). */
export function headFromMatrix(data: number[], mirror: boolean): { rot: THREE.Quaternion; pos: THREE.Vector3 } {
  const m = new THREE.Matrix4();
  // MediaPipe matrices are column-major (translation in 12..14); detect row-major just in case.
  const colMajor = Math.abs(data[12]) + Math.abs(data[13]) + Math.abs(data[14]) >= Math.abs(data[3]) + Math.abs(data[7]) + Math.abs(data[11]);
  if (colMajor) m.fromArray(data); else m.fromArray(data).transpose();
  const pos = new THREE.Vector3();
  const rot = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  m.decompose(pos, rot, scl);
  pos.multiplyScalar(0.01); // cm → m
  if (mirror) {
    rot.set(rot.x, -rot.y, -rot.z, rot.w);
    pos.x = -pos.x;
  }
  return { rot, pos };
}
