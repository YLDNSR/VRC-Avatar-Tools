// Unity animation paths ("Armature/Hips/Hat") → three.js objects of a loaded avatar.
// GLTFLoader keeps the original glTF name in userData.name and makes node.name unique + sanitized
// ("Outfit A" → "Outfit_A", second "Hat" → "Hat_1").
import * as THREE from 'three';
import type { Avatar } from './avatar';

function sanitize(name: string) {
  return THREE.PropertyBinding.sanitizeNodeName(name);
}

export class AvatarPaths {
  /** Paths (and "path / shape") that do not exist in the loaded avatar. */
  readonly missing = new Set<string>();
  private nodes = new Map<string, THREE.Object3D | null>();
  private shapeKeys = new Map<string, string[]>();

  constructor(private avatar: Avatar) {}

  node(path: string): THREE.Object3D | null {
    if (this.nodes.has(path)) return this.nodes.get(path)!;
    let found: THREE.Object3D | null = path === '' ? this.avatar.scene : this.walk(path.split('/'));
    if (!found) {
      // Fall back to the first object with the last name anywhere in the avatar.
      const last = path.split('/').pop() || '';
      this.avatar.scene.traverse((o) => { if (!found && (o.userData?.name === last || o.name === sanitize(last))) found = o; });
    }
    if (!found) this.missing.add(path);
    this.nodes.set(path, found);
    return found;
  }

  private walk(segments: string[]): THREE.Object3D | null {
    let cur: THREE.Object3D = this.avatar.scene;
    for (const seg of segments) {
      const s = sanitize(seg);
      const kids = cur.children;
      const next = kids.find((c) => c.userData?.name === seg) || kids.find((c) => c.name === s) ||
        kids.find((c) => c.name.startsWith(s + '_') && /^\d+$/.test(c.name.slice(s.length + 1)));
      if (!next) return null;
      cur = next;
    }
    return cur;
  }

  /** Meshes of a renderer node in material-slot order (a multi-primitive glTF mesh is a group). */
  slotMeshes(node: THREE.Object3D): THREE.Mesh[] {
    if ((node as THREE.Mesh).isMesh) return [node as THREE.Mesh];
    return node.children.filter((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh[];
  }

  /** Avatar morph layer keys for a blendshape on the mesh at path. */
  morphKeys(path: string, shape: string): string[] {
    const id = `${path}\u0000${shape}`;
    const cached = this.shapeKeys.get(id);
    if (cached) return cached;
    const keys: string[] = [];
    const n = this.node(path);
    if (n) {
      for (const m of this.slotMeshes(n)) {
        const index = m.morphTargetDictionary?.[shape];
        if (index !== undefined) keys.push(`m:${m.uuid}:${index}`);
      }
      if (!keys.length) this.missing.add(`${path} / ${shape}`);
    }
    this.shapeKeys.set(id, keys);
    return keys;
  }
}
