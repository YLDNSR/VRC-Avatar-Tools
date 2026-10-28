// Animation playback: single file, playlist and sets (.vrma / Unity .anim).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip, VRMLookAtQuaternionProxy, type VRMAnimation } from '@pixiv/three-vrm-animation';
import type { Avatar } from './avatar';
import { parseUnityAnim } from './unityAnim';
import { animation as settings, type AnimItem } from './settings';
import type { ViewerBridge } from '../shared/bridge';

const vav = (window as any).vav as ViewerBridge;

export function animItemFromPath(path: string): AnimItem {
  const name = path.split(/[\\/]/).pop() || path;
  return { path, name };
}

export function isAnimationPath(p: string) {
  return /\.(vrma|anim)$/i.test(p);
}

export class AnimationPlayer {
  avatar: Avatar | null = null;
  mixer: THREE.AnimationMixer | null = null;
  private cache = new Map<string, THREE.AnimationClip>();
  private action: THREE.AnimationAction | null = null;
  current: AnimItem | null = null;
  queue: AnimItem[] = [];
  index = -1;
  playing = false;
  warnings: string[] = [];
  onChange?: () => void;
  /** Play / pause / stop / item changes (the avatar's remembered motion). */
  onStateChange?: () => void;
  onError?: (item: AnimItem, err: unknown) => void;
  /** Clips built into the loaded avatar (VRChat sidecar v2), addressed as "avatar-clip:<n>". */
  avatarClip?: (index: number) => THREE.AnimationClip | null;

  private changed() {
    this.onChange?.();
    this.onStateChange?.();
  }

  setAvatar(avatar: Avatar | null) {
    this.stop();
    this.cache.clear();
    this.avatar = avatar;
    this.mixer = avatar ? new THREE.AnimationMixer(avatar.scene) : null;
    if (avatar?.vrm?.lookAt && !avatar.scene.children.some((o) => o instanceof VRMLookAtQuaternionProxy)) {
      const proxy = new VRMLookAtQuaternionProxy(avatar.vrm.lookAt);
      proxy.name = 'VRMLookAtQuaternionProxy';
      avatar.scene.add(proxy);
    }
    this.mixer?.addEventListener('finished', () => this.onFinished());
  }

  get active() {
    return !!this.action;
  }

  private async loadClip(item: AnimItem): Promise<THREE.AnimationClip> {
    const cached = this.cache.get(item.path);
    if (cached) return cached;
    const avatar = this.avatar!;
    let clip: THREE.AnimationClip;
    if (item.path.startsWith('avatar-clip:')) {
      const c = this.avatarClip?.(Number(item.path.slice('avatar-clip:'.length)));
      if (!c) throw new Error('animation not found in this avatar');
      clip = c;
      (clip as any).userData = { loop: true, humanoid: true };
    } else if (/\.anim$/i.test(item.path)) {
      const text = await vav.fs.readText(item.path);
      const r = parseUnityAnim(text, avatar);
      this.warnings = r.warnings;
      clip = r.clip;
      (clip as any).userData = { loop: r.loop, humanoid: r.humanoid };
    } else {
      const loader = new GLTFLoader();
      loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
      const gltf = await loader.loadAsync(vav.fileUrl(item.path));
      const anims = gltf.userData.vrmAnimations as VRMAnimation[] | undefined;
      if (!anims?.length) throw new Error('No VRM animation in file');
      if (!avatar.humanoid) throw new Error('Avatar has no humanoid');
      const vrmLike: any = avatar.vrm || {
        humanoid: avatar.humanoid,
        expressionManager: undefined,
        lookAt: undefined,
        scene: avatar.scene,
        meta: { metaVersion: '1' },
      };
      clip = createVRMAnimationClip(anims[0], vrmLike);
      clip.name = item.name;
      (clip as any).userData = { loop: true, humanoid: true };
    }
    this.cache.set(item.path, clip);
    return clip;
  }

  async play(item: AnimItem, fade = 0.3) {
    if (!this.avatar || !this.mixer) throw new Error('no avatar');
    const clip = await this.loadClip(item);
    const next = this.mixer.clipAction(clip);
    next.reset();
    next.setEffectiveTimeScale(settings.speed || 1);
    const loopOne = settings.repeat === 'one' || (settings.mode === 'single' && settings.repeat !== 'off');
    next.setLoop(loopOne ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    next.clampWhenFinished = true;
    if (this.action && this.action !== next) {
      next.play();
      this.action.crossFadeTo(next, fade, false);
    } else {
      next.play();
    }
    const prev = this.action;
    this.action = next;
    this.current = item;
    this.playing = true;
    this.mixer.timeScale = 1;
    if (prev && prev !== next) setTimeout(() => { if (this.action !== prev) prev.stop(); }, fade * 1000 + 50);
    this.changed();
  }

  async playQueue(items: AnimItem[], start = 0) {
    this.queue = items.slice();
    this.index = Math.min(Math.max(0, start), items.length - 1);
    if (this.index >= 0) await this.safePlay(this.queue[this.index]);
  }

  private async safePlay(item: AnimItem) {
    try {
      await this.play(item);
    } catch (err) {
      this.onError?.(item, err);
    }
  }

  private onFinished() {
    if (settings.mode === 'single') {
      this.playing = false;
      this.changed();
      return;
    }
    if (settings.repeat === 'one') return; // LoopRepeat never finishes
    if (this.index < this.queue.length - 1) this.next();
    else if (settings.repeat === 'all' && this.queue.length) { this.index = -1; this.next(); }
    else { this.playing = false; this.changed(); }
  }

  next() {
    if (!this.queue.length) return;
    this.index = (this.index + 1) % this.queue.length;
    this.safePlay(this.queue[this.index]);
  }

  prev() {
    if (!this.queue.length) return;
    this.index = (this.index - 1 + this.queue.length) % this.queue.length;
    this.safePlay(this.queue[this.index]);
  }

  pause() {
    if (!this.mixer || !this.action) return;
    this.playing = !this.playing;
    this.action.paused = !this.playing;
    this.changed();
  }

  resume() {
    if (this.action) { this.action.paused = false; this.playing = true; this.changed(); }
  }

  stop() {
    if (this.mixer) this.mixer.stopAllAction();
    this.action = null;
    this.current = null;
    this.playing = false;
    this.avatar?.humanoid?.resetNormalizedPose();
    this.changed();
  }

  setSpeed(s: number) {
    if (this.action) this.action.setEffectiveTimeScale(s);
  }

  /** Called when the repeat mode changes so the running action picks it up. */
  refreshLoop() {
    if (!this.action) return;
    const loopOne = settings.repeat === 'one' || (settings.mode === 'single' && settings.repeat !== 'off');
    this.action.setLoop(loopOne ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
  }

  update(dt: number) {
    if (this.mixer && this.action) this.mixer.update(dt);
  }
}
