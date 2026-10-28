// iFacialMocap receiver (UDP 49983). Sends the key string to the iPhone, parses the stream.
import * as THREE from 'three';
import type { CaptureBridge } from '../shared/bridge';

const vav = (window as any).vav as CaptureBridge;
const KEY = 'iFacialMocap_sahuasouryya9218sauhuiayeta91555dy3719';
const PORT = 49983;

export type IfmStatus = 'stopped' | 'noIp' | 'waiting' | 'receiving';

export interface IfmFrame {
  shapes: Record<string, number>; // ARKit names (person's point of view), 0..1
  headEuler: [number, number, number] | null; // degrees
  headPos: [number, number, number] | null;
  rightEye: [number, number, number] | null;
  leftEye: [number, number, number] | null;
}

export function parseIfm(text: string): IfmFrame | null {
  const frame: IfmFrame = { shapes: {}, headEuler: null, headPos: null, rightEye: null, leftEye: null };
  let any = false;
  for (let part of text.split('|')) {
    part = part.trim();
    if (!part) continue;
    if (part.startsWith('=')) part = part.slice(1);
    const hash = part.indexOf('#');
    if (hash > 0) {
      const key = part.slice(0, hash).trim();
      const nums = part.slice(hash + 1).split(',').map((s) => parseFloat(s));
      if (key === 'head' && nums.length >= 3) {
        frame.headEuler = [nums[0], nums[1], nums[2]];
        if (nums.length >= 6) frame.headPos = [nums[3], nums[4], nums[5]];
      } else if (key === 'rightEye' && nums.length >= 3) frame.rightEye = [nums[0], nums[1], nums[2]];
      else if (key === 'leftEye' && nums.length >= 3) frame.leftEye = [nums[0], nums[1], nums[2]];
      any = true;
      continue;
    }
    // "name-value" (v1) or "name&value" (sendDataVersion=v2)
    let sep = part.indexOf('&');
    if (sep < 0) sep = part.lastIndexOf('-');
    if (sep <= 0) continue;
    let name = part.slice(0, sep).trim();
    const value = parseFloat(part.slice(sep + 1));
    if (!Number.isFinite(value)) continue;
    if (name.endsWith('_L')) name = name.slice(0, -2) + 'Left';
    else if (name.endsWith('_R')) name = name.slice(0, -2) + 'Right';
    frame.shapes[name] = Math.min(1, Math.max(0, value / 100));
    any = true;
  }
  return any ? frame : null;
}

/** iFacialMocap head Euler (degrees, Unity convention) → avatar-space quaternion. */
export function ifmHeadRotation(e: [number, number, number], mirror: boolean) {
  const d = THREE.MathUtils.degToRad;
  // Unity applies Z, X, Y (left-handed); convert the result to three.js right-handed space.
  const qu = new THREE.Quaternion().setFromEuler(new THREE.Euler(d(e[0]), d(e[1]), d(e[2]), 'YXZ'));
  const q = new THREE.Quaternion(qu.x, -qu.y, -qu.z, qu.w);
  // The phone faces the user like a mirror; non-mirror output flips the yaw/roll.
  if (!mirror) q.set(q.x, -q.y, -q.z, q.w);
  return q;
}

export class IfmReceiver {
  status: IfmStatus = 'stopped';
  error: string | null = null;
  last: IfmFrame | null = null;
  lastTime = 0;
  private ip = '';
  private timer = 0;
  onStatus?: () => void;
  onFrame?: (f: IfmFrame) => void;

  async start(ip: string) {
    this.ip = ip.trim();
    this.error = null;
    if (!this.ip) { this.setStatus('noIp'); return; }
    const r = await vav.ifm.start(PORT, (text) => this.onPacket(text), (e) => { this.error = e; this.onStatus?.(); });
    if (!r.ok) { this.error = r.error || 'error'; this.setStatus('stopped'); return; }
    this.setStatus('waiting');
    clearInterval(this.timer);
    const hello = () => vav.ifm.handshake(this.ip, PORT, `${KEY}|sendDataVersion=v2`);
    hello();
    this.timer = window.setInterval(() => {
      const fresh = performance.now() - this.lastTime < 1500;
      if (!fresh) {
        if (this.status === 'receiving') this.setStatus('waiting');
        hello();
      }
    }, 1500);
  }

  stop() {
    clearInterval(this.timer);
    vav.ifm.stop();
    this.last = null;
    this.setStatus('stopped');
  }

  private setStatus(s: IfmStatus) {
    if (this.status !== s) { this.status = s; this.onStatus?.(); }
  }

  private onPacket(text: string) {
    const f = parseIfm(text);
    if (!f) return;
    this.last = f;
    this.lastTime = performance.now();
    this.setStatus('receiving');
    this.onFrame?.(f);
  }

  active() {
    return this.status === 'receiving' && performance.now() - this.lastTime < 1000;
  }
}
