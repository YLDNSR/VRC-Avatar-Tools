// Clicking the desktop character: where it was touched decides the reaction (the head: a pat, the body: a start,
// a hand or a leg: looking at it), and poking it again and again makes it pout.
import * as THREE from 'three';
import type { VRMHumanBoneName } from '@pixiv/three-vrm';
import type { App } from '../app';
import type { LifeMotion } from './life';
import type { ReactionName } from './actions';

type Part = 'head' | 'body' | 'leftHand' | 'rightHand' | 'leg';

const POINTS: [Part, VRMHumanBoneName[]][] = [
  ['body', ['upperChest', 'chest', 'spine', 'hips']],
  ['leftHand', ['leftHand', 'leftLowerArm']],
  ['rightHand', ['rightHand', 'rightLowerArm']],
  ['leg', ['leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg', 'leftFoot', 'rightFoot']],
];

const REACTION: Record<Part, ReactionName> = { head: 'pat', body: 'poke', leftHand: 'handL', rightHand: 'handR', leg: 'leg' };

const tmp = new THREE.Vector3();
const neck = new THREE.Vector3();
const right = new THREE.Vector3();

/**
 * The body part at window point (x, y): the head when the point is on it, else the nearest bone.
 * onAvatar: the point is known to be on the avatar (transparent background); otherwise it has to be near.
 */
export function partAt(app: App, x: number, y: number, onAvatar: boolean): Part | null {
  const h = app.avatar?.humanoid;
  if (!h) return null;
  const cam = app.stage.rig.camera;
  const toScreen = (p: THREE.Vector3) => {
    const q = tmp.copy(p).project(cam);
    return q.z > 1 ? null : { x: ((q.x + 1) / 2) * window.innerWidth, y: ((1 - q.y) / 2) * window.innerHeight };
  };
  const at = (b: VRMHumanBoneName) => h.getRawBoneNode(b)?.getWorldPosition(new THREE.Vector3()) || null;
  const head = at('head'), hips = at('hips');
  if (!head || !hips) return null;

  // The head: a ball above the head bone, sized from the body.
  const size = head.distanceTo(hips);
  const radius = size * 0.22;
  const n = at('neck');
  const up = n ? head.clone().sub(neck.copy(n)).normalize() : new THREE.Vector3(0, 1, 0);
  const centre = head.clone().addScaledVector(up, radius * 0.8);
  const c = toScreen(centre);
  right.setFromMatrixColumn(cam.matrixWorld, 0);
  const edge = toScreen(centre.clone().addScaledVector(right, radius * 1.25));
  const headPx = c && edge ? Math.hypot(edge.x - c.x, edge.y - c.y) : 0;
  if (c && Math.hypot(x - c.x, y - c.y) < headPx) return 'head';

  let best: Part | null = null;
  let bestD = Infinity;
  for (const [part, bones] of POINTS) {
    for (const b of bones) {
      const p = at(b);
      const s = p && toScreen(p);
      if (!s) continue;
      const d = Math.hypot(x - s.x, y - s.y);
      if (d < bestD) { bestD = d; best = part; }
    }
  }
  return onAvatar || bestD < Math.max(40, headPx * 1.6) ? best : null;
}

export class Interaction {
  /** Times (s) of the last pokes (not pats) */
  private pokes: number[] = [];
  /** When it last pouted (s): poked again soon after, it keeps pouting */
  private poutAt = -Infinity;

  constructor(private app: App, private life: LifeMotion) {}

  /** A left click at window point (x, y); false when it was not on the avatar. */
  click(x: number, y: number, onAvatar: boolean): boolean {
    const part = partAt(this.app, x, y, onAvatar);
    if (!part) return false;
    let name = REACTION[part];
    if (part !== 'head') {
      const now = performance.now() / 1000;
      this.pokes = this.pokes.filter((t) => now - t < 4);
      this.pokes.push(now);
      if (this.pokes.length >= 4 || now - this.poutAt < 2.5) { name = 'annoyed'; this.pokes = []; this.poutAt = now; }
    }
    this.life.attention();
    this.life.actions.play(name);
    this.app.markActive();
    return true;
  }
}
