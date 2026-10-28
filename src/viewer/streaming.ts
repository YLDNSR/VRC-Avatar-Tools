// Streaming input: VMC protocol (bones + blendshapes) and VRChat OSC (VRCFaceTracking v2).
import * as THREE from 'three';
import { VRMLookAtBoneApplier } from '@pixiv/three-vrm';
import { decodeOsc } from '../shared/osc';
import { UNITY_TO_VRM, boneGroup } from '../shared/bones';
import { VRM0_TO_VRM1, vrcftToShapes, categoryOf, ARKIT_NAMES, type FaceCategory } from '../shared/face';
import type { Avatar } from './avatar';
import { convertForModel } from './avatar';
import { streaming as settings } from './settings';
import type { AvatarProfile, ViewerBridge } from '../shared/bridge';

const vav = (window as any).vav as ViewerBridge;
const ARKIT_LOWER = new Set(ARKIT_NAMES.map((n) => n.toLowerCase()));

export type InputStatus = 'stopped' | 'waiting' | 'receiving';

interface BoneSample { rot: THREE.Quaternion; pos: THREE.Vector3 }

const tmpQ = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();
const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const Y180 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

function smoothingAlpha(s: number, dt: number) {
  if (s <= 0.001) return 1;
  const tau = s * 0.3; // seconds
  return 1 - Math.exp(-dt / tau);
}

function smoothingKeyFor(cat: FaceCategory): string {
  if (cat === 'blink') return 'blink';
  if (cat === 'gaze') return 'gaze';
  if (cat === 'brow') return 'brow';
  return 'mouth';
}

export class StreamingInput {
  avatar: Avatar | null = null;
  running = false;
  vmcStatus: InputStatus = 'stopped';
  oscStatus: InputStatus = 'stopped';
  vmcError: string | null = null;
  oscError: string | null = null;
  profile: AvatarProfile | null = null;
  onGesture?: (side: 'left' | 'right', value: number) => void;
  onStatus?: () => void;

  private vmcSocket: number | null = null;
  private oscSocket: number | null = null;
  private bones = new Map<string, BoneSample>();
  private root: BoneSample | null = null;
  private blendPending = new Map<string, number>();
  private blend = new Map<string, number>();
  private oscParams = new Map<string, number>();
  private lastVmc = 0;
  private lastOsc = 0;
  private vmcPackets = 0;
  private oscPackets = 0;
  vmcPps = 0;
  oscPps = 0;
  private ppsTimer = 0;
  private smoothBones = new Map<string, THREE.Quaternion>();
  private smoothBlend = new Map<string, number>();
  private hipsRef: THREE.Vector3 | null = null;
  private wasApplyingBones = false;
  private headBaseline: THREE.Vector3 | null = null;
  /** -1..1 zoom emphasis signal from head forward/back motion */
  zoomSignal = 0;
  /** true while incoming data drives the face's gaze */
  drivesGaze = false;
  fingersTracked = { left: false, right: false };
  headTracked = false;

  get bonesCount() { return this.bones.size; }
  get blendCount() { return this.blend.size; }
  get oscCount() { return this.oscParams.size; }

  setAvatar(a: Avatar | null) {
    this.avatar = a;
    this.smoothBones.clear();
    this.smoothBlend.clear();
    this.hipsRef = null;
    this.headBaseline = null;
  }

  needsOsc() {
    return settings.connection === 'osc' || settings.faceType === 'vrcft';
  }

  async start() {
    await this.stop();
    this.running = true;
    this.vmcError = null;
    this.oscError = null;
    if (settings.connection === 'vmc') {
      const r = await vav.udp.listen(settings.vmcPort, (data) => this.onVmc(data), (e) => { this.vmcError = e; this.onStatus?.(); });
      if (r.ok) { this.vmcSocket = r.id!; this.vmcStatus = 'waiting'; } else { this.vmcError = r.error || 'error'; this.vmcStatus = 'stopped'; }
    }
    if (this.needsOsc()) {
      const r = await vav.udp.listen(settings.oscPort, (data) => this.onOsc(data), (e) => { this.oscError = e; this.onStatus?.(); });
      if (r.ok) { this.oscSocket = r.id!; this.oscStatus = 'waiting'; } else { this.oscError = r.error || 'error'; this.oscStatus = 'stopped'; }
    }
    this.ppsTimer = window.setInterval(() => {
      this.vmcPps = this.vmcPackets; this.oscPps = this.oscPackets;
      this.vmcPackets = 0; this.oscPackets = 0;
      this.onStatus?.();
    }, 1000);
    this.onStatus?.();
  }

  async stop() {
    if (this.vmcSocket != null) vav.udp.close(this.vmcSocket);
    if (this.oscSocket != null) vav.udp.close(this.oscSocket);
    this.vmcSocket = null;
    this.oscSocket = null;
    clearInterval(this.ppsTimer);
    this.running = false;
    this.vmcStatus = 'stopped';
    this.oscStatus = 'stopped';
    this.bones.clear();
    this.blend.clear();
    this.blendPending.clear();
    this.oscParams.clear();
    this.root = null;
    this.hipsRef = null;
    this.headBaseline = null;
    if (this.avatar) {
      this.avatar.clearLayer('stream');
      if (this.wasApplyingBones) this.avatar.humanoid?.resetNormalizedPose();
      this.resetAvatarRoot();
    }
    this.wasApplyingBones = false;
    this.fingersTracked = { left: false, right: false };
    this.headTracked = false;
    this.drivesGaze = false;
    this.onStatus?.();
  }

  private onVmc(data: Uint8Array) {
    this.lastVmc = performance.now();
    this.vmcPackets++;
    if (this.vmcStatus !== 'receiving') { this.vmcStatus = 'receiving'; this.onStatus?.(); }
    for (const m of decodeOsc(data)) {
      const a = m.args;
      switch (m.address) {
        case '/VMC/Ext/Bone/Pos': {
          if (a.length < 8 || typeof a[0] !== 'string') break;
          let s = this.bones.get(a[0]);
          if (!s) { s = { rot: new THREE.Quaternion(), pos: new THREE.Vector3() }; this.bones.set(a[0], s); }
          // Unity (left-handed) → three.js (right-handed): mirror X
          s.pos.set(-(a[1] as number), a[2] as number, a[3] as number);
          s.rot.set(a[4] as number, -(a[5] as number), -(a[6] as number), a[7] as number).normalize();
          break;
        }
        case '/VMC/Ext/Root/Pos': {
          if (a.length < 8) break;
          if (!this.root) this.root = { rot: new THREE.Quaternion(), pos: new THREE.Vector3() };
          this.root.pos.set(-(a[1] as number), a[2] as number, a[3] as number);
          this.root.rot.set(a[4] as number, -(a[5] as number), -(a[6] as number), a[7] as number).normalize();
          break;
        }
        case '/VMC/Ext/Blend/Val':
          if (typeof a[0] === 'string' && typeof a[1] === 'number') this.blendPending.set(a[0], a[1]);
          break;
        case '/VMC/Ext/Blend/Apply':
          this.blend = new Map(this.blendPending);
          break;
        default:
          break;
      }
    }
  }

  private onOsc(data: Uint8Array) {
    this.lastOsc = performance.now();
    this.oscPackets++;
    if (this.oscStatus !== 'receiving') { this.oscStatus = 'receiving'; this.onStatus?.(); }
    for (const m of decodeOsc(data)) {
      if (!m.address.startsWith('/avatar/parameters/')) continue;
      const name = m.address.slice('/avatar/parameters/'.length);
      let v = m.args[0];
      if (typeof v === 'boolean') v = v ? 1 : 0;
      if (typeof v !== 'number') continue;
      if (name === 'GestureLeft' || name === 'GestureRight') {
        this.onGesture?.(name === 'GestureLeft' ? 'left' : 'right', Math.round(v));
        continue;
      }
      if (name.startsWith('v2/')) this.oscParams.set(name.slice(3), v);
      else if (name.startsWith('FT/v2/')) this.oscParams.set(name.slice(6), v);
    }
  }

  private resetAvatarRoot() {
    const a = this.avatar;
    if (!a) return;
    a.scene.position.set(0, 0, 0);
    a.scene.quaternion.copy(a.metaVersion === '0' ? Y180 : tmpQ.identity());
  }

  vmcActive() {
    return this.vmcStatus === 'receiving' && performance.now() - this.lastVmc < 1500;
  }

  oscActive() {
    return this.oscStatus === 'receiving' && performance.now() - this.lastOsc < 1500;
  }

  /** Applies received data to the avatar. Call after the animation mixer, before avatar.update(). */
  update(dt: number) {
    const a = this.avatar;
    if (!a || !this.running) return;
    const now = performance.now();
    if (this.vmcStatus === 'receiving' && now - this.lastVmc > 3000) { this.vmcStatus = 'waiting'; this.onStatus?.(); }
    if (this.oscStatus === 'receiving' && now - this.lastOsc > 3000) { this.oscStatus = 'waiting'; this.onStatus?.(); }

    const vmcLive = this.vmcActive();
    this.fingersTracked = { left: false, right: false };
    this.headTracked = false;
    if (vmcLive && a.humanoid) {
      this.applyBones(a, dt);
      this.wasApplyingBones = true;
    } else if (this.wasApplyingBones) {
      a.humanoid?.resetNormalizedPose();
      this.resetAvatarRoot();
      this.smoothBones.clear();
      this.wasApplyingBones = false;
    }

    const layer = new Map<string, number>();
    this.drivesGaze = false;
    if (settings.faceType === 'vrcft') {
      if (this.oscActive()) this.applyVrcft(a, layer);
    } else if (vmcLive) {
      this.applyBlends(a, dt, layer);
    }
    if (layer.size) a.setLayer('stream', layer); else a.clearLayer('stream');
  }

  private applyBones(a: Avatar, dt: number) {
    const sm = settings.smoothing;
    for (const [unityName, s] of this.bones) {
      const vrmName = UNITY_TO_VRM.get(unityName);
      if (!vrmName) continue;
      if (vrmName === 'leftEye' || vrmName === 'rightEye') continue; // handled as gaze
      const node = a.normalizedBone(vrmName);
      if (!node) continue;
      const group = boneGroup(vrmName);
      const key = group === 'head' ? 'head' : group === 'arms' ? 'arms' : 'body';
      const alpha = smoothingAlpha(sm[key] ?? 0, dt);
      convertForModel(s.rot, a.metaVersion, tmpQ);
      let cur = this.smoothBones.get(vrmName);
      if (!cur) { cur = tmpQ.clone(); this.smoothBones.set(vrmName, cur); }
      cur.slerp(tmpQ, alpha);
      node.quaternion.copy(cur);
      if (/Thumb|Index|Middle|Ring|Little/.test(vrmName)) {
        if (vrmName.startsWith('left')) this.fingersTracked.left = true; else this.fingersTracked.right = true;
      }
      if (vrmName === 'head' || vrmName === 'neck') this.headTracked = true;
      if (vrmName === 'hips') {
        const hips = node;
        const rest = a.humanoid!.normalizedRestPose.hips?.position;
        if (rest) {
          if (!this.hipsRef) this.hipsRef = s.pos.clone();
          tmpV.copy(s.pos).sub(this.hipsRef);
          if (a.metaVersion === '0') tmpV.set(-tmpV.x, tmpV.y, -tmpV.z);
          hips.position.set(rest[0] + tmpV.x, rest[1] + tmpV.y, rest[2] + tmpV.z);
        }
      }
    }
    // Root motion (whole-body translation / rotation from the sender)
    if (this.root) {
      const alpha = smoothingAlpha(sm.body ?? 0, dt);
      a.scene.position.lerp(this.root.pos, alpha);
      tmpQ2.copy(this.root.rot);
      if (a.metaVersion === '0') tmpQ2.multiply(Y180);
      a.scene.quaternion.slerp(tmpQ2, alpha);
    }
    // Gaze from eye bones
    const le = this.bones.get('LeftEye'), re = this.bones.get('RightEye');
    const eye = le || re;
    if (eye && a.vrm?.lookAt) {
      tmpV.set(0, 0, 1).applyQuaternion(eye.rot);
      const yaw = THREE.MathUtils.radToDeg(Math.atan2(tmpV.x, tmpV.z));
      const pitch = THREE.MathUtils.radToDeg(-Math.asin(THREE.MathUtils.clamp(tmpV.y, -1, 1)));
      this.setGaze(a, yaw, pitch, settings.smoothing.gaze ?? 0, dt);
    }
    if (settings.ik) this.correctArms(a);
    this.updateZoomSignal(a);
  }

  private gazeState = { yaw: 0, pitch: 0 };
  private setGaze(a: Avatar, yaw: number, pitch: number, smooth: number, dt: number) {
    const k = smoothingAlpha(smooth, dt);
    const strength = settings.strength.gaze ?? 1;
    this.gazeState.yaw += (yaw * strength - this.gazeState.yaw) * k;
    this.gazeState.pitch += (pitch * strength - this.gazeState.pitch) * k;
    const la = a.vrm?.lookAt;
    if (la) {
      la.target = null;
      la.yaw = this.gazeState.yaw;
      la.pitch = this.gazeState.pitch;
    }
    this.drivesGaze = true;
  }

  /** Keeps hands from sinking into the torso (IK arm correction). */
  private correctArms(a: Avatar) {
    const chest = a.normalizedBone('upperChest') || a.normalizedBone('chest') || a.normalizedBone('spine');
    const ls = a.normalizedBone('leftUpperArm'), rs = a.normalizedBone('rightUpperArm');
    if (!chest || !ls || !rs) return;
    a.scene.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(chest.matrixWorld).invert();
    const pl = ls.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
    const pr = rs.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
    const halfWidth = Math.abs(pl.x - pr.x) * 0.42;
    const depth = halfWidth * 0.9;
    for (const side of ['left', 'right'] as const) {
      const upper = side === 'left' ? ls : rs;
      const hand = a.normalizedBone(`${side}Hand`);
      if (!hand) continue;
      const sign = side === 'left' ? 1 : -1;
      for (let i = 0; i < 10; i++) {
        upper.updateMatrixWorld(true);
        const hp = hand.getWorldPosition(tmpV2).applyMatrix4(inv);
        const inside = Math.abs(hp.x) < halfWidth && hp.z > -depth && hp.z < depth && hp.y < 0.05;
        if (!inside) break;
        // rotate the upper arm outward around the chest forward axis
        tmpQ.setFromAxisAngle(new THREE.Vector3(0, 0, 1), sign * THREE.MathUtils.degToRad(4));
        if (a.metaVersion === '0') tmpQ.set(-tmpQ.x, tmpQ.y, -tmpQ.z, tmpQ.w);
        upper.quaternion.premultiply(tmpQ);
      }
    }
  }

  private updateZoomSignal(a: Avatar) {
    const head = a.normalizedBone('head');
    if (!head) return;
    a.scene.updateMatrixWorld(true);
    const p = head.getWorldPosition(tmpV);
    if (!this.headBaseline) this.headBaseline = p.clone();
    // slowly follow so the effect stays centered
    this.headBaseline.lerp(p, 0.002);
    this.zoomSignal = THREE.MathUtils.clamp((p.z - this.headBaseline.z) / 0.25, -1, 1);
  }

  private profileTargets(source: string): { keys: string[]; min: number; max: number }[] | null {
    if (!this.profile || !this.avatar) return null;
    const out: { keys: string[]; min: number; max: number }[] = [];
    for (const e of this.profile.expressions) {
      if (e.source.toLowerCase() !== source.toLowerCase()) continue;
      out.push({ keys: this.avatar.resolveShape(e.target, e.renderer), min: e.minWeight / 100, max: e.maxWeight / 100 });
    }
    return out.length ? out : null;
  }

  private applyBlends(a: Avatar, dt: number, layer: Map<string, number>) {
    const ps = settings.faceType === 'ps';
    let gazeX = 0, gazeY = 0, gazeSeen = false;
    for (const [name, raw] of this.blend) {
      const lower = name.toLowerCase();
      const cat = categoryOf(name);
      const strength = settings.strength[cat] ?? 1;
      const skey = smoothingKeyFor(cat);
      const target = THREE.MathUtils.clamp(raw * strength, 0, 1);
      const prev = this.smoothBlend.get(name) ?? target;
      const v = prev + (target - prev) * smoothingAlpha(settings.smoothing[skey] ?? 0, dt);
      this.smoothBlend.set(name, v);

      const mapped = this.profileTargets(name);
      if (mapped) {
        for (const m of mapped) for (const k of m.keys) layer.set(k, Math.max(layer.get(k) || 0, m.min + (m.max - m.min) * v));
        continue;
      }
      if (lower === 'lookup') { gazeY += v; gazeSeen = true; }
      if (lower === 'lookdown') { gazeY -= v; gazeSeen = true; }
      if (lower === 'lookleft') { gazeX -= v; gazeSeen = true; }
      if (lower === 'lookright') { gazeX += v; gazeSeen = true; }

      const vrm1 = VRM0_TO_VRM1[lower];
      let keys: string[] = [];
      if (vrm1 && !(ps && ARKIT_LOWER.has(lower))) keys = a.resolveExpression(vrm1);
      if (!keys.length && (ps || !vrm1)) keys = a.resolveShape(name);
      for (const k of keys) layer.set(k, Math.max(layer.get(k) || 0, v));
    }
    // Bone-type lookAt avatars: convert Look* blends into yaw/pitch when no eye bones arrive.
    if (gazeSeen && !this.bones.has('LeftEye') && a.vrm?.lookAt && a.vrm.lookAt.applier instanceof VRMLookAtBoneApplier) {
      this.setGaze(a, -gazeX * 12, -gazeY * 10, 0, dt);
    }
  }

  private applyVrcft(a: Avatar, layer: Map<string, number>) {
    const params: Record<string, number> = {};
    for (const [k, v] of this.oscParams) params[k] = v;
    const out = vrcftToShapes(params);
    // Unified Expressions shapes on the mesh take priority, then ARKit / Perfect Sync shapes.
    let anyMorph = false;
    for (const [name, v] of Object.entries(out.ue)) {
      const refs = a.morphsByExact.get(name.toLowerCase());
      if (!refs) continue;
      for (const r of refs) layer.set(r.key, Math.max(layer.get(r.key) || 0, v));
      anyMorph = true;
    }
    for (const [name, v] of Object.entries(out.arkit)) {
      const keys = a.resolveShape(name);
      for (const k of keys) { layer.set(k, Math.max(layer.get(k) || 0, v)); anyMorph = true; }
    }
    if (!anyMorph) {
      // VRM-only avatars: drive the basic expressions from the same data.
      const set = (n: string, v: number) => { for (const k of a.resolveExpression(n)) layer.set(k, Math.max(layer.get(k) || 0, v)); };
      set('blinkLeft', out.arkit.eyeBlinkLeft || 0);
      set('blinkRight', out.arkit.eyeBlinkRight || 0);
      set('aa', out.arkit.jawOpen || 0);
      set('ou', Math.max(out.arkit.mouthPucker || 0, out.arkit.mouthFunnel || 0) * 0.8);
      set('happy', Math.min(out.arkit.mouthSmileLeft || 0, out.arkit.mouthSmileRight || 0) * 0.8);
    }
    if (out.gaze && a.vrm?.lookAt) {
      const x = (out.gaze.leftX + out.gaze.rightX) / 2;
      const y = (out.gaze.leftY + out.gaze.rightY) / 2;
      const la = a.vrm.lookAt;
      la.target = null;
      la.yaw = -x * 25;
      la.pitch = -y * 20;
      this.drivesGaze = true;
    }
  }
}
