// VMC protocol + VRChat OSC sending.
import * as THREE from 'three';
import { encodeBundles, encodeMessage, int, type OscArg } from '../shared/osc';
import { VRM_TO_UNITY } from '../shared/bones';
import type { CaptureBridge } from '../shared/bridge';

const vav = (window as any).vav as CaptureBridge;

export interface VmcFrame {
  bones: Map<string, THREE.Quaternion>; // VRM bone name → avatar-space local rotation
  rootPos: THREE.Vector3;
  blends: Record<string, number>;
}

export class Sender {
  packets = 0;
  pps = 0;
  private ppsTimer = 0;
  private lastOsc = new Map<string, number>();
  private lastOscRefresh = 0;
  private lastOscSend = 0;
  private startTime = performance.now();

  constructor() {
    this.ppsTimer = window.setInterval(() => { this.pps = this.packets; this.packets = 0; }, 1000);
  }

  dispose() {
    clearInterval(this.ppsTimer);
  }

  sendVmc(host: string, port: number, f: VmcFrame) {
    const msgs: [string, OscArg[]][] = [];
    msgs.push(['/VMC/Ext/OK', [int(1)]]);
    msgs.push(['/VMC/Ext/T', [(performance.now() - this.startTime) / 1000]]);
    // three.js (right-handed) → Unity (left-handed): mirror X
    msgs.push(['/VMC/Ext/Root/Pos', ['root', -f.rootPos.x, f.rootPos.y, f.rootPos.z, 0, 0, 0, 1]]);
    for (const [bone, q] of f.bones) {
      const unity = VRM_TO_UNITY.get(bone);
      if (!unity) continue;
      const pos = bone === 'hips' ? [0, 1, 0] : [0, 0, 0];
      msgs.push(['/VMC/Ext/Bone/Pos', [unity, pos[0], pos[1], pos[2], q.x, -q.y, -q.z, q.w]]);
    }
    for (const [name, value] of Object.entries(f.blends)) msgs.push(['/VMC/Ext/Blend/Val', [name, value]]);
    msgs.push(['/VMC/Ext/Blend/Apply', []]);
    const packets = encodeBundles(msgs);
    vav.udp.sendMany(host, port, packets);
    this.packets += packets.length;
  }

  /** VRChat OSC: /avatar/parameters/v2/<name>, throttled to ~30 fps, only changed values (full refresh every 2 s). */
  sendVrcft(host: string, port: number, params: Record<string, number>, force = false) {
    const now = performance.now();
    if (!force && now - this.lastOscSend < 32) return;
    this.lastOscSend = now;
    const refresh = now - this.lastOscRefresh > 2000;
    if (refresh) this.lastOscRefresh = now;
    const packets: Uint8Array[] = [];
    for (const [name, raw] of Object.entries(params)) {
      const value = Math.round(raw * 1000) / 1000;
      const prev = this.lastOsc.get(name);
      if (!refresh && prev !== undefined && Math.abs(prev - value) < 0.004) continue;
      this.lastOsc.set(name, value);
      packets.push(encodeMessage(`/avatar/parameters/v2/${name}`, [value]));
    }
    if (packets.length) {
      vav.udp.sendMany(host, port, packets);
      this.packets += packets.length;
    }
  }

  sendOscBool(host: string, port: number, name: string, value: boolean) {
    vav.udp.sendMany(host, port, [encodeMessage(`/avatar/parameters/${name}`, [value])]);
  }

  resetOsc() {
    this.lastOsc.clear();
  }
}
