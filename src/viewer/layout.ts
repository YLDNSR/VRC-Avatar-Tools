// Avatar placement (position / rotation / scale) and camera view: saved per avatar, lockable, resettable.
import * as THREE from 'three';
import type { Stage } from './stage';
import { persisted } from '../shared/store';
import { streaming } from './settings';

export interface Layout {
  /** Avatar root position (m) */
  pos: [number, number, number];
  /** Avatar root rotation (degrees, Euler XYZ) */
  rot: [number, number, number];
  scale: number;
  camera: { target: number[]; distance: number; yaw: number; pitch: number; fov: number };
  savedAt: string;
}

export const layoutSettings = persisted('settings.layout', {
  /** Mouse / keyboard cannot move the avatar or the camera. */
  locked: false,
  /** Apply the avatar's saved layout when it is opened. */
  autoRestore: true,
  /** Saved layouts by avatar key (file name without extension). */
  byAvatar: {} as Record<string, Layout>,
  /** The most recent save of any avatar (used by "restore" when this avatar has none). */
  last: null as Layout | null,
});

// The streaming panel's old global camera save becomes the fallback layout.
if (!layoutSettings.last && streaming.savedCamera?.rig) {
  const c = streaming.savedCamera;
  layoutSettings.last = {
    pos: (c.root?.pos || [0, 0, 0]) as [number, number, number],
    rot: [0, THREE.MathUtils.radToDeg(c.root?.rot || 0), 0],
    scale: 1,
    camera: { target: c.rig.target, distance: c.rig.distance, yaw: c.rig.yaw, pitch: c.rig.pitch, fov: c.rig.fov || streaming.fov },
    savedAt: new Date().toISOString(),
  };
  layoutSettings.save();
}

/** Same avatar re-exported to another folder keeps its layout. */
export function layoutKey(avatarPath: string) {
  return (avatarPath.split(/[\\/]/).pop() || avatarPath).replace(/\.(vrm|glb|gltf)$/i, '').toLowerCase();
}

export function captureLayout(stage: Stage): Layout {
  const r = stage.avatarRoot;
  const deg = THREE.MathUtils.radToDeg;
  const s = stage.rig.snapshot();
  return {
    pos: [r.position.x, r.position.y, r.position.z],
    rot: [deg(r.rotation.x), deg(r.rotation.y), deg(r.rotation.z)],
    scale: r.scale.x,
    camera: { target: s.target, distance: s.distance, yaw: s.yaw, pitch: s.pitch, fov: s.fov },
    savedAt: new Date().toISOString(),
  };
}

export function applyLayout(stage: Stage, l: Layout) {
  const r = stage.avatarRoot;
  const rad = THREE.MathUtils.degToRad;
  r.position.fromArray(l.pos);
  r.rotation.set(rad(l.rot[0]), rad(l.rot[1]), rad(l.rot[2]));
  r.scale.setScalar(clampScale(l.scale));
  const cam = stage.rig.camera;
  if (l.camera.fov && Math.abs(l.camera.fov - cam.fov) > 1e-3) {
    cam.fov = l.camera.fov;
    cam.updateProjectionMatrix();
    streaming.fov = l.camera.fov;
    streaming.save();
  }
  stage.rig.restore(l.camera);
}

/** Avatar at the origin, facing forward, scale 1, camera framing the whole body (the field of view is kept). */
export function resetLayout(stage: Stage) {
  stage.rig.reset();
  stage.avatarRoot.position.set(0, 0, 0);
  stage.avatarRoot.rotation.set(0, 0, 0);
  stage.avatarRoot.scale.setScalar(1);
}

export function clampScale(v: number) {
  return Number.isFinite(v) ? Math.min(10, Math.max(0.05, v)) : 1;
}
