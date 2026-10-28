// Loads VRM / glTF avatars and provides humanoid + expression control.
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, VRMHumanoid, type VRM, type VRMHumanBones } from '@pixiv/three-vrm';
import { ARKIT_NAMES, UE_SHAPES, VRC_FALLBACK_MORPHS, normalizeShapeName } from '../shared/face';

export interface MorphRef {
  mesh: THREE.Mesh;
  index: number;
  name: string;
  key: string;
}

export interface AvatarInfo {
  title: string;
  author: string;
  format: string;
  meshes: number;
  triangles: number;
  materials: number;
  textures: number;
  bones: number;
  humanBones: number;
  morphs: number;
  springJoints: number;
  expressions: number;
}

const tmpV = new THREE.Vector3();

/** Converts a rotation expressed for an avatar facing +Z into the model's normalized-bone space. */
export function convertForModel(q: THREE.Quaternion, metaVersion: '0' | '1', out = new THREE.Quaternion()) {
  if (metaVersion === '0') return out.set(-q.x, q.y, -q.z, q.w);
  return out.copy(q);
}

export class Avatar {
  path: string;
  gltf: GLTF;
  scene: THREE.Object3D;
  vrm: VRM | null;
  humanoid: VRMHumanoid | null;
  metaVersion: '0' | '1' = '1';
  meshes: THREE.Mesh[] = [];
  morphs: MorphRef[] = [];
  morphByKey = new Map<string, MorphRef>();
  morphsByNorm = new Map<string, MorphRef[]>();
  morphsByExact = new Map<string, MorphRef[]>();
  boundMorphKeys = new Set<string>();
  expressionNames: string[] = [];
  private exprLower = new Map<string, string>();
  restBox = new THREE.Box3();
  soleOffset = 0;
  info: AvatarInfo;
  warnings: string[] = [];
  hasAnimatedShader = false;

  // Expression/morph layers: layer → (target key → weight)
  private layers = new Map<string, Map<string, number>>();
  private lastExpr = new Set<string>();
  private lastMorph = new Set<string>();
  private combined = new Map<string, number>();

  private constructor(path: string, gltf: GLTF) {
    this.path = path;
    this.gltf = gltf;
    this.vrm = (gltf.userData.vrm as VRM) || null;
    this.scene = this.vrm ? this.vrm.scene : gltf.scene;
    this.humanoid = this.vrm ? this.vrm.humanoid : null;
  }

  static async load(url: string, path: string, onProgress?: (ratio: number) => void): Promise<Avatar> {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser, { autoUpdateHumanBones: true }));
    const gltf = await loader.loadAsync(url, (e) => {
      if (onProgress && e.total) onProgress(e.loaded / e.total);
    });
    const a = new Avatar(path, gltf);
    a.init();
    return a;
  }

  private init() {
    const vrm = this.vrm;
    if (vrm) {
      VRMUtils.removeUnnecessaryVertices(this.scene);
      VRMUtils.combineSkeletons(this.scene);
      this.metaVersion = vrm.meta?.metaVersion === '0' ? '0' : '1';
      if (this.metaVersion === '0') VRMUtils.rotateVRM0(vrm);
      if (vrm.lookAt) vrm.lookAt.autoUpdate = true;
    } else {
      this.humanoid = this.buildGenericHumanoid();
      if (this.humanoid) this.scene.add(this.humanoid.normalizedHumanBonesRoot);
    }

    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if ((m as any).isMesh) {
        m.frustumCulled = false;
        this.meshes.push(m);
        const dict = m.morphTargetDictionary;
        if (dict) {
          for (const [name, index] of Object.entries(dict)) {
            const ref: MorphRef = { mesh: m, index, name, key: `m:${m.uuid}:${index}` };
            this.morphs.push(ref);
            this.morphByKey.set(ref.key, ref);
            const n = normalizeShapeName(name);
            if (!this.morphsByNorm.has(n)) this.morphsByNorm.set(n, []);
            this.morphsByNorm.get(n)!.push(ref);
            const lower = name.toLowerCase();
            if (!this.morphsByExact.has(lower)) this.morphsByExact.set(lower, []);
            this.morphsByExact.get(lower)!.push(ref);
          }
        }
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (const mat of mats as any[]) {
          if (mat && (mat.uvAnimationScrollXSpeedFactor || mat.uvAnimationScrollYSpeedFactor || mat.uvAnimationRotationSpeedFactor)) {
            this.hasAnimatedShader = true;
          }
        }
      }
    });

    if (vrm?.expressionManager) {
      for (const expr of vrm.expressionManager.expressions) {
        this.expressionNames.push(expr.expressionName);
        this.exprLower.set(expr.expressionName.toLowerCase(), expr.expressionName);
        for (const bind of (expr as any)._binds || []) {
          const prims: THREE.Mesh[] = bind.primitives || [];
          for (const p of prims) {
            if (typeof bind.index === 'number') this.boundMorphKeys.add(`m:${p.uuid}:${bind.index}`);
          }
        }
      }
    }

    this.scene.updateMatrixWorld(true);
    this.restBox.setFromObject(this.scene, true);
    if (this.restBox.isEmpty()) this.restBox.set(new THREE.Vector3(-0.3, 0, -0.3), new THREE.Vector3(0.3, 1.6, 0.3));
    const foot = this.footY();
    this.soleOffset = foot != null ? Math.max(0, foot - this.restBox.min.y) : 0;
    this.info = this.computeInfo();
  }

  // -------------------------------------------------------------------------
  // Generic glTF humanoid detection (for non-VRM models in T-pose)

  private buildGenericHumanoid(): VRMHumanoid | null {
    const bones: THREE.Object3D[] = [];
    this.scene.traverse((o) => { if ((o as any).isBone || o.type === 'Bone') bones.push(o); });
    const nodes = bones.length ? bones : (() => { const a: THREE.Object3D[] = []; this.scene.traverse((o) => a.push(o)); return a; })();
    const clean = (n: string) => n.toLowerCase().replace(/^mixamorig\d*[:_]?/, '').replace(/^(j_bip_|bip0?1?_?|def[-_]|armature[|_])/, '');
    const sideOf = (n: string): 'l' | 'r' | null => {
      const c = clean(n);
      if (/(^|[^a-z])(left|l)([^a-z]|$)/.test(c.replace(/left/, ' left ')) || /left/.test(c) || /[._\s-]l$/.test(c) || /^l[._\s-]/.test(c)) return 'l';
      if (/right/.test(c) || /[._\s-]r$/.test(c) || /^r[._\s-]/.test(c)) return 'r';
      return null;
    };
    const has = (n: string, words: string[]) => { const c = clean(n); return words.some((w) => c.includes(w)); };
    const find = (pred: (o: THREE.Object3D) => boolean, from: THREE.Object3D[] = nodes) => from.find(pred) || null;

    const hips = find((o) => has(o.name, ['hips', 'pelvis']) && !sideOf(o.name)) || find((o) => /(^|[^a-z])hip$/.test(clean(o.name)));
    const head = find((o) => has(o.name, ['head']) && !sideOf(o.name) && !has(o.name, ['headtop', 'head_end', 'headend', 'top']));
    if (!hips || !head) {
      this.warnings.push('Humanoid bones were not detected; motion input is disabled for this model.');
      return null;
    }
    const map: Partial<Record<string, THREE.Object3D>> = { hips, head };
    const neck = head.parent && has(head.parent.name, ['neck']) ? head.parent : find((o) => has(o.name, ['neck']) && !sideOf(o.name));
    if (neck) map.neck = neck;
    // Spine chain between hips and neck/head
    const chain: THREE.Object3D[] = [];
    let cur: THREE.Object3D | null = (neck || head).parent;
    while (cur && cur !== hips && chain.length < 8) { chain.unshift(cur); cur = cur.parent; }
    if (cur === hips) {
      if (chain[0]) map.spine = chain[0];
      if (chain[1]) map.chest = chain[1];
      if (chain[2]) map.upperChest = chain[chain.length - 1];
    }
    const upperBody = (map.upperChest || map.chest || map.spine || hips) as THREE.Object3D;
    const descendants = (root: THREE.Object3D) => { const a: THREE.Object3D[] = []; root.traverse((o) => { if (o !== root) a.push(o); }); return a; };
    const firstChildOnPath = (o: THREE.Object3D) => o.children.find((c) => c.children.length > 0 || (c as any).isBone) || o.children[0] || null;

    for (const s of ['l', 'r'] as const) {
      const side = s === 'l' ? 'left' : 'right';
      // Legs
      const legStart = hips.children.flatMap((c) => [c, ...descendants(c)]).find((o) => sideOf(o.name) === s && has(o.name, ['upleg', 'upperleg', 'thigh', 'leg']) && !has(o.name, ['lower', 'knee', 'calf']));
      if (legStart) {
        map[`${side}UpperLeg`] = legStart;
        const lower = firstChildOnPath(legStart);
        if (lower) {
          map[`${side}LowerLeg`] = lower;
          const foot = firstChildOnPath(lower);
          if (foot) {
            map[`${side}Foot`] = foot;
            const toe = foot.children.find((c) => has(c.name, ['toe'])) || null;
            if (toe) map[`${side}Toes`] = toe;
          }
        }
      }
      // Arms
      const armCandidates = descendants(upperBody).filter((o) => sideOf(o.name) === s);
      const shoulder = armCandidates.find((o) => has(o.name, ['shoulder', 'clavicle']));
      let upperArm = armCandidates.find((o) => has(o.name, ['upperarm', 'upper_arm', 'arm']) && !has(o.name, ['fore', 'lower', 'elbow']) && o !== shoulder);
      if (!upperArm && shoulder) upperArm = firstChildOnPath(shoulder) || undefined;
      if (shoulder && shoulder !== upperArm) map[`${side}Shoulder`] = shoulder;
      if (upperArm) {
        map[`${side}UpperArm`] = upperArm;
        const lowerArm = firstChildOnPath(upperArm);
        if (lowerArm) {
          map[`${side}LowerArm`] = lowerArm;
          const hand = firstChildOnPath(lowerArm);
          if (hand) {
            map[`${side}Hand`] = hand;
            const fingerDefs: [string, string[]][] = [
              ['Thumb', ['thumb']], ['Index', ['index']], ['Middle', ['middle']], ['Ring', ['ring']], ['Little', ['little', 'pinky']],
            ];
            for (const [f, words] of fingerDefs) {
              const root = hand.children.find((c) => has(c.name, words));
              if (!root) continue;
              const segs = f === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal'];
              let node: THREE.Object3D | null = root;
              for (const seg of segs) {
                if (!node) break;
                map[`${side}${f}${seg}`] = node;
                node = node.children[0] || null;
              }
            }
          }
        }
      }
    }
    const humanBones: any = {};
    for (const [k, v] of Object.entries(map)) if (v) humanBones[k] = { node: v };
    const required = ['hips', 'spine', 'head', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
      'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand'];
    const missing = required.filter((r) => !humanBones[r]);
    if (missing.length) this.warnings.push(`Humanoid bones not found: ${missing.join(', ')}`);
    if (!humanBones.spine) {
      this.warnings.push('Spine bone missing; motion input is disabled for this model.');
      return null;
    }
    return new VRMHumanoid(humanBones as VRMHumanBones, { autoUpdateHumanBones: true });
  }

  // -------------------------------------------------------------------------

  private computeInfo(): AvatarInfo {
    let triangles = 0;
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    const skeletonBones = new Set<THREE.Object3D>();
    for (const m of this.meshes) {
      const g = m.geometry;
      triangles += g.index ? g.index.count / 3 : (g.attributes.position?.count || 0) / 3;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) {
        materials.add(mat);
        for (const v of Object.values(mat as any)) if (v && (v as any).isTexture) textures.add(v as THREE.Texture);
        // MToon keeps its textures in shader uniforms behind getters.
        for (const u of Object.values(((mat as any).uniforms || {}) as Record<string, { value: any }>)) {
          if (u?.value?.isTexture) textures.add(u.value);
        }
      }
      const sk = (m as THREE.SkinnedMesh).skeleton;
      if (sk) for (const b of sk.bones) skeletonBones.add(b);
    }
    const vrm = this.vrm as any;
    let springJoints = 0;
    if (vrm?.springBoneManager) springJoints = vrm.springBoneManager.joints?.size ?? 0;
    const meta = vrm?.meta || {};
    const humanBones = this.humanoid ? Object.keys(this.humanoid.humanBones).length : 0;
    const fileName = this.path.split(/[\\/]/).pop() || '';
    return {
      title: meta.name || meta.title || fileName.replace(/\.[^.]+$/, ''),
      author: Array.isArray(meta.authors) ? meta.authors.join(', ') : meta.author || '',
      format: vrm ? (this.metaVersion === '0' ? 'VRM 0.x' : 'VRM 1.0') : 'glTF',
      meshes: this.meshes.length,
      triangles: Math.round(triangles),
      materials: materials.size,
      textures: textures.size,
      bones: skeletonBones.size,
      humanBones,
      morphs: this.morphs.length,
      springJoints,
      expressions: this.expressionNames.length,
    };
  }

  /** Lowest foot/toe bone height in the given object's local space (null if no humanoid). */
  footY(space?: THREE.Object3D): number | null {
    if (!this.humanoid) return null;
    let min = Infinity;
    for (const b of ['leftFoot', 'rightFoot', 'leftToes', 'rightToes'] as const) {
      const n = this.humanoid.getRawBoneNode(b);
      if (!n) continue;
      n.getWorldPosition(tmpV);
      if (space) space.worldToLocal(tmpV);
      if (tmpV.y < min) min = tmpV.y;
    }
    return Number.isFinite(min) ? min : null;
  }

  height() {
    return Math.max(0.3, this.restBox.max.y - this.restBox.min.y);
  }

  normalizedBone(name: string): THREE.Object3D | null {
    return this.humanoid ? this.humanoid.getNormalizedBoneNode(name as any) : null;
  }

  /** Sum of spring bone tail motion during the last update (for idle detection). */
  springMotion(): number {
    const mgr = (this.vrm as any)?.springBoneManager;
    if (!mgr?.joints) return 0;
    let max = 0;
    for (const j of mgr.joints) {
      const c = j._currentTail, p = j._prevTail;
      if (c && p) {
        const d = c.distanceToSquared(p);
        if (d > max) max = d;
      }
    }
    return Math.sqrt(max);
  }

  resetSprings() {
    (this.vrm as any)?.springBoneManager?.reset?.();
  }

  // -------------------------------------------------------------------------
  // Expressions

  /** Finds a VRM expression by name (case-insensitive). */
  expression(name: string): string | null {
    return this.exprLower.get(name.toLowerCase()) || null;
  }

  /**
   * Target keys for a VRM-style expression (happy, aa, blinkLeft, …):
   * VRM expression first, then common VRChat / MMD blendshape names.
   */
  resolveExpression(name: string): string[] {
    const e = this.expression(name);
    if (e) return [`e:${e}`];
    const fallbacks = VRC_FALLBACK_MORPHS[name];
    if (fallbacks) {
      for (const f of fallbacks) {
        const refs = this.morphsByExact.get(f.toLowerCase());
        if (refs?.length) return refs.map((r) => r.key);
      }
    }
    return [];
  }

  /** Target keys for a raw shape name (ARKit / Unified Expressions / custom). */
  resolveShape(name: string, renderer?: string | null): string[] {
    if (!renderer) {
      const e = this.expression(name);
      if (e) return [`e:${e}`];
    }
    let refs = this.morphsByExact.get(name.toLowerCase()) || this.morphsByNorm.get(normalizeShapeName(name)) || [];
    if (renderer) refs = refs.filter((r) => r.mesh.name === renderer || r.mesh.parent?.name === renderer);
    else if (refs.length > 1) {
      // Prefer meshes that look like a face/body; avoid clothes with the same shape names.
      const preferred = refs.filter((r) => /face|head|body|顔|체/i.test(r.mesh.name) || /face|head|body/i.test(r.mesh.parent?.name || ''));
      refs = preferred.length ? preferred : [refs[0]];
    }
    return refs.map((r) => r.key);
  }

  faceSupport() {
    const vrmBasic = !!this.vrm?.expressionManager?.getExpression('blink') || !!this.vrm?.expressionManager?.getExpression('aa') ||
      this.resolveExpression('aa').length > 0 || this.resolveExpression('blink').length > 0;
    let ps = 0;
    for (const n of ARKIT_NAMES) if (this.resolveShape(n).length) ps++;
    let ue = 0;
    for (const n of UE_SHAPES) if (this.morphsByExact.has(n.toLowerCase())) ue++;
    return { vrm: vrmBasic, perfectSync: ps >= 40, perfectSyncCount: ps, vrcft: ue >= 20 || ps >= 40, ueCount: ue };
  }

  setLayer(id: string, values: Map<string, number>) {
    this.layers.set(id, values);
  }

  clearLayer(id: string) {
    this.layers.delete(id);
  }

  getLayer(id: string) {
    return this.layers.get(id);
  }

  /** Call before vrm.update(): pushes expression weights. */
  preUpdate() {
    const combined = this.combined;
    combined.clear();
    for (const layer of this.layers.values()) {
      for (const [k, v] of layer) {
        const prev = combined.get(k);
        if (prev === undefined || v > prev) combined.set(k, v);
      }
    }
    const em = this.vrm?.expressionManager;
    const nowExpr = new Set<string>();
    if (em) {
      for (const [k, v] of combined) {
        if (k.startsWith('e:')) {
          const name = k.slice(2);
          em.setValue(name, Math.min(1, Math.max(0, v)));
          nowExpr.add(name);
        }
      }
      for (const name of this.lastExpr) if (!nowExpr.has(name)) em.setValue(name, 0);
    }
    this.lastExpr = nowExpr;
  }

  /** Call after vrm.update(): applies raw morph weights. */
  postUpdate() {
    const nowMorph = new Set<string>();
    for (const [k, v] of this.combined) {
      if (!k.startsWith('m:')) continue;
      const ref = this.morphByKey.get(k);
      if (!ref || !ref.mesh.morphTargetInfluences) continue;
      const w = Math.min(1, Math.max(0, v));
      if (this.boundMorphKeys.has(k)) ref.mesh.morphTargetInfluences[ref.index] = Math.min(1, ref.mesh.morphTargetInfluences[ref.index] + w);
      else ref.mesh.morphTargetInfluences[ref.index] = w;
      nowMorph.add(k);
    }
    for (const k of this.lastMorph) {
      if (nowMorph.has(k) || this.boundMorphKeys.has(k)) continue;
      const ref = this.morphByKey.get(k);
      if (ref?.mesh.morphTargetInfluences) ref.mesh.morphTargetInfluences[ref.index] = 0;
    }
    this.lastMorph = nowMorph;
  }

  update(dt: number) {
    this.preUpdate();
    if (this.vrm) this.vrm.update(dt);
    else this.humanoid?.update();
    this.postUpdate();
  }

  dispose() {
    this.scene.removeFromParent();
    VRMUtils.deepDispose(this.scene);
  }
}
