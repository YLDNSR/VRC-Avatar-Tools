// "Upper body" camera for the broadcast: from a little above the head down to the chest, facing the
// avatar. OBS gets the same view through Syphon (or a window capture with a transparent background).
import * as THREE from 'three';
import type { App } from '../app';

const v = (o: THREE.Object3D | null | undefined) => (o ? o.getWorldPosition(new THREE.Vector3()) : null);

/** Highest point of what is shown now (hair, ears, hats), in the current pose; hidden outfits do not count. */
function visibleTop(root: THREE.Object3D): number | null {
  let top = -Infinity;
  const box = new THREE.Box3();
  root.traverseVisible((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const sm = m as unknown as THREE.SkinnedMesh;
    if (sm.isSkinnedMesh) {
      // Bounds with the bones applied (the geometry's own box would be the bind pose).
      sm.computeBoundingBox();
      if (!sm.boundingBox) return;
      box.copy(sm.boundingBox);
    } else {
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      box.copy(m.geometry.boundingBox!);
    }
    box.applyMatrix4(m.matrixWorld);
    if (!box.isEmpty()) top = Math.max(top, box.max.y);
  });
  return Number.isFinite(top) ? top : null;
}

/** false when there is no avatar. */
export function frameUpperBody(app: App, tightness = 1): boolean {
  const a = app.avatar;
  if (!a) return false;
  const stage = app.stage;
  stage.avatarRoot.updateMatrixWorld(true);
  const h = a.humanoid;
  const head = v(h?.getNormalizedBoneNode('head'));
  const hips = v(h?.getNormalizedBoneNode('hips'));
  const box = a.restBox.clone().applyMatrix4(a.scene.matrixWorld);
  const height = Math.max(0.3, box.max.y - box.min.y);
  let top: number;
  let bottom: number;
  let cx: number;
  let cz: number;
  if (head && hips && head.y > hips.y) {
    // From just above the hair / ears down to the chest.
    const crown = visibleTop(a.scene);
    const headTop = crown != null && crown > head.y && crown < head.y + height * 0.4 ? crown : head.y + height * 0.12;
    bottom = hips.y + (head.y - hips.y) * 0.28;
    top = headTop + (headTop - bottom) * 0.06;
    cx = head.x;
    cz = head.z;
  } else {
    top = box.max.y + height * 0.03;
    bottom = box.min.y + height * 0.55;
    const c = box.getCenter(new THREE.Vector3());
    cx = c.x;
    cz = c.z;
  }
  const span = Math.max(0.15, (top - bottom) / tightness);
  const rig = stage.rig;
  const fov = THREE.MathUtils.degToRad(rig.camera.fov);
  // Closer: the top stays just above the head, the bottom moves up.
  rig.target.set(cx, top - span / 2, cz);
  rig.distance = (span * 1.04) / (2 * Math.tan(fov / 2));
  rig.pitch = 0.03;
  // Look at the avatar's front.
  rig.yaw = stage.avatarRoot.rotation.y;
  app.markActive();
  return true;
}
