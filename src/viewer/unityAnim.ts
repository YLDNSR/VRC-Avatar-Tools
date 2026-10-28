// Unity .anim (YAML AnimationClip) → three.js AnimationClip.
//
// Humanoid muscle curves are converted approximately: Unity's exact muscle space
// depends on per-avatar pre/post rotations that are not stored in the clip, so each
// muscle is mapped to a swing/twist axis of the VRM normalized bone using Unity's
// default muscle limits, measured relative to a T-pose.
import * as THREE from 'three';
import { parseAllDocuments } from 'yaml';
import type { Avatar } from './avatar';
import { convertForModel } from './avatar';

interface Key { time: number; value: number; inSlope: number; outSlope: number }
interface Curve { keys: Key[] }

// [muscle name, min, max, T-pose value]
const LIMITS: Record<string, [number, number, number]> = {};
function lim(name: string, min: number, max: number, tpose = 0) { LIMITS[name] = [min, max, tpose]; }
for (const p of ['Spine', 'Chest']) { lim(`${p} Front-Back`, -40, 40); lim(`${p} Left-Right`, -40, 40); lim(`${p} Twist Left-Right`, -40, 40); }
lim('UpperChest Front-Back', -20, 20); lim('UpperChest Left-Right', -20, 20); lim('UpperChest Twist Left-Right', -20, 20);
for (const p of ['Neck', 'Head']) { lim(`${p} Nod Down-Up`, -40, 40); lim(`${p} Tilt Left-Right`, -40, 40); lim(`${p} Turn Left-Right`, -40, 40); }
lim('Jaw Close', -10, 10); lim('Jaw Left-Right', -10, 10);
for (const s of ['Left', 'Right']) {
  lim(`${s} Upper Leg Front-Back`, -90, 50, 0.6); lim(`${s} Upper Leg In-Out`, -60, 60); lim(`${s} Upper Leg Twist In-Out`, -60, 60);
  lim(`${s} Lower Leg Stretch`, -80, 80, 1); lim(`${s} Lower Leg Twist In-Out`, -90, 90);
  lim(`${s} Foot Up-Down`, -50, 50); lim(`${s} Foot Twist In-Out`, -30, 30); lim(`${s} Toes Up-Down`, -50, 50);
  lim(`${s} Shoulder Down-Up`, -15, 30); lim(`${s} Shoulder Front-Back`, -15, 15);
  lim(`${s} Arm Down-Up`, -60, 100, 0.4); lim(`${s} Arm Front-Back`, -100, 100, 0.3); lim(`${s} Arm Twist In-Out`, -90, 90);
  lim(`${s} Forearm Stretch`, -80, 80, 1); lim(`${s} Forearm Twist In-Out`, -90, 90);
  lim(`${s} Hand Down-Up`, -80, 80); lim(`${s} Hand In-Out`, -40, 40);
  lim(`${s}Hand.Thumb.1 Stretched`, -20, 20, 1); lim(`${s}Hand.Thumb.Spread`, -25, 25); lim(`${s}Hand.Thumb.2 Stretched`, -40, 35, 1); lim(`${s}Hand.Thumb.3 Stretched`, -40, 35, 1);
  for (const f of ['Index', 'Middle', 'Ring', 'Little']) {
    lim(`${s}Hand.${f}.1 Stretched`, -50, 50, 1); lim(`${s}Hand.${f}.Spread`, -20, 20); lim(`${s}Hand.${f}.2 Stretched`, -45, 45, 1); lim(`${s}Hand.${f}.3 Stretched`, -45, 45, 1);
  }
}

// Bone → list of [muscle, axis ('x'|'y'|'z'), sign]; angle (deg) = sign * (f(m) - f(T)).
type AxisDef = [string, 'x' | 'y' | 'z', number];
const BONES: Record<string, AxisDef[]> = {
  spine: [['Spine Front-Back', 'x', -1], ['Spine Left-Right', 'z', 1], ['Spine Twist Left-Right', 'y', -1]],
  chest: [['Chest Front-Back', 'x', -1], ['Chest Left-Right', 'z', 1], ['Chest Twist Left-Right', 'y', -1]],
  upperChest: [['UpperChest Front-Back', 'x', -1], ['UpperChest Left-Right', 'z', 1], ['UpperChest Twist Left-Right', 'y', -1]],
  neck: [['Neck Nod Down-Up', 'x', -1], ['Neck Tilt Left-Right', 'z', 1], ['Neck Turn Left-Right', 'y', -1]],
  head: [['Head Nod Down-Up', 'x', -1], ['Head Tilt Left-Right', 'z', 1], ['Head Turn Left-Right', 'y', -1]],
  jaw: [['Jaw Close', 'x', -1], ['Jaw Left-Right', 'y', -1]],
};
for (const side of ['left', 'right'] as const) {
  const S = side === 'left' ? 'Left' : 'Right';
  const m = side === 'left' ? 1 : -1; // mirror sign for side-dependent axes
  BONES[`${side}UpperLeg`] = [[`${S} Upper Leg Front-Back`, 'x', 1], [`${S} Upper Leg In-Out`, 'z', m], [`${S} Upper Leg Twist In-Out`, 'y', m]];
  BONES[`${side}LowerLeg`] = [[`${S} Lower Leg Stretch`, 'x', -1], [`${S} Lower Leg Twist In-Out`, 'y', m]];
  BONES[`${side}Foot`] = [[`${S} Foot Up-Down`, 'x', 1], [`${S} Foot Twist In-Out`, 'y', m]];
  BONES[`${side}Toes`] = [[`${S} Toes Up-Down`, 'x', 1]];
  BONES[`${side}Shoulder`] = [[`${S} Shoulder Down-Up`, 'z', m], [`${S} Shoulder Front-Back`, 'y', m]];
  BONES[`${side}UpperArm`] = [[`${S} Arm Down-Up`, 'z', m], [`${S} Arm Front-Back`, 'y', m], [`${S} Arm Twist In-Out`, 'x', -1]];
  BONES[`${side}LowerArm`] = [[`${S} Forearm Stretch`, 'y', m], [`${S} Forearm Twist In-Out`, 'x', -1]];
  BONES[`${side}Hand`] = [[`${S} Hand Down-Up`, 'z', m], [`${S} Hand In-Out`, 'y', m]];
  BONES[`${side}ThumbMetacarpal`] = [[`${S}Hand.Thumb.1 Stretched`, 'x', -1], [`${S}Hand.Thumb.Spread`, 'y', -m]];
  BONES[`${side}ThumbProximal`] = [[`${S}Hand.Thumb.2 Stretched`, 'x', -1]];
  BONES[`${side}ThumbDistal`] = [[`${S}Hand.Thumb.3 Stretched`, 'x', -1]];
  for (const f of ['Index', 'Middle', 'Ring', 'Little']) {
    const spreadSign = f === 'Index' ? -m : f === 'Middle' ? 0 : m;
    BONES[`${side}${f}Proximal`] = [[`${S}Hand.${f}.1 Stretched`, 'z', m], [`${S}Hand.${f}.Spread`, 'y', spreadSign]];
    BONES[`${side}${f}Intermediate`] = [[`${S}Hand.${f}.2 Stretched`, 'z', m]];
    BONES[`${side}${f}Distal`] = [[`${S}Hand.${f}.3 Stretched`, 'z', m]];
  }
}

function muscleAngle(name: string, value: number): number {
  const l = LIMITS[name];
  if (!l) return 0;
  const f = (v: number) => (v >= 0 ? v * l[1] : -v * l[0]);
  return f(value) - f(l[2]);
}

function evalCurve(c: Curve, t: number): number {
  const k = c.keys;
  if (k.length === 0) return 0;
  if (t <= k[0].time) return k[0].value;
  if (t >= k[k.length - 1].time) return k[k.length - 1].value;
  let i = 0;
  let lo = 0, hi = k.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (k[mid].time <= t) { i = mid; lo = mid + 1; } else hi = mid - 1;
  }
  const a = k[i], b = k[i + 1];
  const dt = b.time - a.time;
  if (dt <= 0) return b.value;
  if (!Number.isFinite(a.outSlope) || !Number.isFinite(b.inSlope)) return a.value;
  const s = (t - a.time) / dt;
  const s2 = s * s, s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * a.value + (s3 - 2 * s2 + s) * dt * a.outSlope + (-2 * s3 + 3 * s2) * b.value + (s3 - s2) * dt * b.inSlope;
}

function num(v: any): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    if (/^-?inf/i.test(v) || v === '.inf' || v === '-.inf') return v.startsWith('-') ? -Infinity : Infinity;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function toCurve(raw: any, comp?: string): Curve {
  const keys: Key[] = [];
  for (const k of raw?.m_Curve || []) {
    if (comp) {
      keys.push({ time: num(k.time), value: num(k.value?.[comp]), inSlope: num(k.inSlope?.[comp]), outSlope: num(k.outSlope?.[comp]) });
    } else {
      keys.push({ time: num(k.time), value: num(k.value), inSlope: num(k.inSlope), outSlope: num(k.outSlope) });
    }
  }
  keys.sort((a, b) => a.time - b.time);
  return { keys };
}

function lastNodeName(path: string) {
  const parts = String(path || '').split('/');
  return parts[parts.length - 1];
}

export interface UnityAnimResult {
  clip: THREE.AnimationClip;
  humanoid: boolean;
  loop: boolean;
  warnings: string[];
}

export function parseUnityAnim(text: string, avatar: Avatar): UnityAnimResult {
  // Unity YAML uses %TAG directives and "--- !u!74 &7400000" document headers.
  const cleaned = text
    .split('\n')
    .filter((l) => !l.startsWith('%'))
    .map((l) => (l.startsWith('--- !u!') ? '---' : l))
    .join('\n');
  const docs = parseAllDocuments(cleaned, { uniqueKeys: false, strict: false } as any);
  let clipDoc: any = null;
  for (const d of Array.isArray(docs) ? docs : [docs]) {
    const js = (d as any).toJS?.({ maxAliasCount: -1 });
    if (js && js.AnimationClip) { clipDoc = js.AnimationClip; break; }
  }
  if (!clipDoc) throw new Error('AnimationClip not found in file');

  const warnings: string[] = [];
  const name = clipDoc.m_Name || 'anim';
  const settings = clipDoc.m_AnimationClipSettings || {};
  const loop = num(settings.m_LoopTime) === 1;
  const sampleRate = Math.min(60, Math.max(10, num(clipDoc.m_SampleRate) || 30));

  const muscles = new Map<string, Curve>();
  const rootT: Record<string, Curve> = {};
  const rootQ: Record<string, Curve> = {};
  const blendshapes: { path: string; shape: string; curve: Curve }[] = [];
  const actives: { path: string; curve: Curve }[] = [];
  let duration = 0;
  const track = (c: Curve) => { if (c.keys.length) duration = Math.max(duration, c.keys[c.keys.length - 1].time); return c; };

  for (const fc of clipDoc.m_FloatCurves || []) {
    const attr: string = String(fc.attribute || '');
    const classID = num(fc.classID);
    const curve = track(toCurve(fc.curve));
    if (classID === 95) {
      if (/^RootT\.[xyz]$/.test(attr)) rootT[attr.slice(-1)] = curve;
      else if (/^RootQ\.[xyzw]$/.test(attr)) rootQ[attr.slice(-1)] = curve;
      else if (LIMITS[attr]) muscles.set(attr, curve);
    } else if (classID === 137 && attr.startsWith('blendShape.')) {
      blendshapes.push({ path: fc.path, shape: attr.slice('blendShape.'.length), curve });
    } else if (classID === 1 && attr === 'm_IsActive') {
      actives.push({ path: fc.path, curve });
    }
  }
  const stop = num(settings.m_StopTime);
  if (stop > duration) duration = stop;
  if (duration <= 0) duration = 1 / sampleRate;

  const frames = Math.max(2, Math.round(duration * sampleRate) + 1);
  const times = new Float32Array(frames);
  for (let i = 0; i < frames; i++) times[i] = Math.min(duration, i / sampleRate);

  const tracks: THREE.KeyframeTrack[] = [];
  const humanoid = muscles.size > 0 || Object.keys(rootQ).length > 0;

  if (humanoid && avatar.humanoid) {
    const q = new THREE.Quaternion();
    const qAxis = new THREE.Quaternion();
    const rv = new THREE.Vector3();
    const tw = new THREE.Quaternion();
    for (const [bone, defs] of Object.entries(BONES)) {
      const node = avatar.normalizedBone(bone);
      if (!node) continue;
      if (!defs.some(([m]) => muscles.has(m))) continue;
      const values = new Float32Array(frames * 4);
      for (let i = 0; i < frames; i++) {
        const t = times[i];
        // swing from the two non-twist axes, then twist; twist axis is the bone direction
        const ang: Record<string, number> = { x: 0, y: 0, z: 0 };
        for (const [m, axis, sign] of defs) {
          const c = muscles.get(m);
          const v = c ? evalCurve(c, t) : LIMITS[m][2];
          ang[axis] += sign * THREE.MathUtils.degToRad(muscleAngle(m, v));
        }
        const twistAxis = /Arm|Hand|Thumb|Index|Middle|Ring|Little|Shoulder/.test(bone) ? 'x' : 'y';
        rv.set(twistAxis === 'x' ? 0 : ang.x, twistAxis === 'y' ? 0 : ang.y, ang.z);
        const swingAngle = rv.length();
        if (swingAngle > 1e-6) qAxis.setFromAxisAngle(rv.divideScalar(swingAngle), swingAngle); else qAxis.identity();
        tw.setFromAxisAngle(twistAxis === 'x' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0), ang[twistAxis]);
        q.copy(qAxis).multiply(tw);
        convertForModel(q, avatar.metaVersion, q);
        values.set([q.x, q.y, q.z, q.w], i * 4);
      }
      tracks.push(new THREE.QuaternionKeyframeTrack(`${node.name}.quaternion`, times, values));
    }
    // Body (root) rotation drives the hips; height drives the hips position.
    const hips = avatar.normalizedBone('hips');
    if (hips) {
      if (rootQ.w) {
        const values = new Float32Array(frames * 4);
        const q0 = new THREE.Quaternion();
        for (let i = 0; i < frames; i++) {
          const t = times[i];
          // Unity (left-handed) → three.js: (x, -y, -z, w)
          q0.set(evalCurve(rootQ.x, t), -evalCurve(rootQ.y, t), -evalCurve(rootQ.z, t), evalCurve(rootQ.w, t)).normalize();
          convertForModel(q0, avatar.metaVersion, q0);
          values.set([q0.x, q0.y, q0.z, q0.w], i * 4);
        }
        tracks.push(new THREE.QuaternionKeyframeTrack(`${hips.name}.quaternion`, times, values));
      }
      if (rootT.y) {
        const restY = (avatar.humanoid.normalizedRestPose.hips?.position?.[1]) ?? hips.position.y;
        const base = hips.position.clone();
        const values = new Float32Array(frames * 3);
        for (let i = 0; i < frames; i++) {
          values.set([base.x, restY * evalCurve(rootT.y, times[i]), base.z], i * 3);
        }
        tracks.push(new THREE.VectorKeyframeTrack(`${hips.name}.position`, times, values));
      }
    }
  } else if (humanoid) {
    warnings.push('Humanoid clip but the avatar has no humanoid bones');
  }

  // Blendshape curves (0..100 → 0..1)
  for (const b of blendshapes) {
    const meshName = lastNodeName(b.path);
    const mesh = avatar.meshes.find((m) => m.name === meshName || m.parent?.name === meshName) as THREE.Mesh | undefined;
    const candidates = mesh ? [mesh, ...avatar.meshes.filter((m) => m.parent === mesh.parent && m !== mesh)] : avatar.meshes;
    let added = false;
    for (const m of candidates) {
      const idx = m.morphTargetDictionary?.[b.shape];
      if (idx === undefined) continue;
      const values = new Float32Array(frames);
      for (let i = 0; i < frames; i++) values[i] = Math.min(1, Math.max(0, evalCurve(b.curve, times[i]) / 100));
      tracks.push(new THREE.NumberKeyframeTrack(`${m.uuid}.morphTargetInfluences[${idx}]`, times, values));
      added = true;
    }
    if (!added) warnings.push(`blendshape not found: ${b.path} / ${b.shape}`);
  }

  // GameObject on/off
  for (const a of actives) {
    const nodeName = lastNodeName(a.path);
    let target: THREE.Object3D | null = null;
    avatar.scene.traverse((o) => { if (!target && o.name === nodeName) target = o; });
    if (!target) continue;
    const values: boolean[] = [];
    for (let i = 0; i < frames; i++) values.push(evalCurve(a.curve, times[i]) >= 0.5);
    tracks.push(new THREE.BooleanKeyframeTrack(`${(target as THREE.Object3D).uuid}.visible`, Array.from(times), values));
  }

  if (!tracks.length) warnings.push('No usable curves in this clip');
  return { clip: new THREE.AnimationClip(name, duration, tracks), humanoid, loop, warnings };
}
