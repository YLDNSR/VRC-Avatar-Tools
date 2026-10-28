// Renderer, scene, camera rig, lighting, stand and light marker.
import * as THREE from 'three';
import { lighting, general, streaming, LIGHT_PRESETS, LIGHT_DEFAULTS } from './settings';

export const HELPER_LAYER = 1; // rendered in the window only, not in Syphon output

/** Approximate RGB for a color temperature in Kelvin (Tanner Helland). */
export function kelvinToColor(k: number): THREE.Color {
  const t = k / 100;
  let r: number, g: number, b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  const c = (v: number) => Math.min(255, Math.max(0, v)) / 255;
  // Normalize so 6500K is neutral white.
  const base = { r: 255 / 255, g: 249 / 255, b: 253 / 255 };
  return new THREE.Color().setRGB(c(r) / base.r, c(g) / base.g, c(b) / base.b, THREE.SRGBColorSpace);
}

export class CameraRig {
  camera: THREE.PerspectiveCamera;
  target = new THREE.Vector3(0, 0.9, 0);
  distance = 3;
  yaw = 0;
  pitch = 0.05;
  /** extra zoom factor applied on top of distance (zoom emphasis) */
  zoomFactor = 1;
  home = { target: new THREE.Vector3(0, 0.9, 0), distance: 3, pitch: 0.05 };

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(streaming.fov, aspect, 0.03, 100);
    this.camera.layers.enable(HELPER_LAYER);
  }

  apply() {
    const d = this.distance * this.zoomFactor;
    const cp = Math.cos(this.pitch);
    this.camera.position.set(
      this.target.x + Math.sin(this.yaw) * cp * d,
      this.target.y + Math.sin(this.pitch) * d,
      this.target.z + Math.cos(this.yaw) * cp * d,
    );
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();
  }

  /** Frames a bounding box (full body) and stores it as the home position. */
  frame(box: THREE.Box3) {
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const height = Math.max(size.y, 0.3);
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    // Full body plus a little room for the stand and the toolbar.
    const fitH = (height * 1.3) / (2 * Math.tan(fov / 2));
    const fitW = (Math.max(size.x, size.z) * 1.15) / (2 * Math.tan(fov / 2) * this.camera.aspect);
    this.home.target.set(center.x, box.min.y + height * 0.47, center.z);
    this.home.distance = Math.max(fitH, fitW, 0.4);
    this.home.pitch = 0.05;
    this.reset();
  }

  reset() {
    this.target.copy(this.home.target);
    this.distance = this.home.distance;
    this.pitch = this.home.pitch;
    this.yaw = 0;
  }

  /** Changes FOV while keeping the subject the same size (dolly zoom). */
  setFov(fov: number) {
    const oldT = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const newT = Math.tan(THREE.MathUtils.degToRad(fov) / 2);
    this.distance *= oldT / newT;
    this.home.distance *= oldT / newT;
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  /** World-space size of one screen pixel at the target distance. */
  worldPerPixel(viewportHeight: number) {
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    return (2 * Math.tan(fov / 2) * this.distance * this.zoomFactor) / Math.max(1, viewportHeight);
  }

  snapshot() {
    return { target: this.target.toArray(), distance: this.distance, yaw: this.yaw, pitch: this.pitch, fov: this.camera.fov };
  }

  restore(s: any) {
    if (!s) return;
    this.target.fromArray(s.target);
    this.distance = s.distance;
    this.yaw = s.yaw;
    this.pitch = s.pitch;
  }
}

export class Stage {
  canvas: HTMLCanvasElement;
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  rig: CameraRig;
  /** Holds the avatar; left-drag rotates it, right-drag moves it. */
  avatarRoot = new THREE.Group();
  /** Inner offset group (Y offset during animation playback). */
  avatarOffset = new THREE.Group();
  mainLight: THREE.DirectionalLight;
  ambient: THREE.AmbientLight;
  stand: THREE.Mesh;
  standBaseRadius = 0.45;
  marker: THREE.Group;
  transparent = false;
  private lightTarget = new THREE.Object3D();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, premultipliedAlpha: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.rig = new CameraRig(1);

    this.avatarRoot.name = 'AvatarRoot';
    this.avatarOffset.name = 'AvatarOffset';
    this.avatarRoot.add(this.avatarOffset);
    this.scene.add(this.avatarRoot);

    this.mainLight = new THREE.DirectionalLight(0xffffff, Math.PI);
    this.mainLight.target = this.lightTarget;
    this.scene.add(this.mainLight, this.lightTarget);
    this.ambient = new THREE.AmbientLight(0xffffff, 1);
    this.scene.add(this.ambient);

    const standMat = new THREE.MeshStandardMaterial({ color: 0x7c8190, roughness: 0.55, metalness: 0.1 });
    const standGeo = new THREE.CylinderGeometry(1, 1.04, 0.06, 64);
    standGeo.translate(0, -0.03, 0);
    this.stand = new THREE.Mesh(standGeo, standMat);
    this.stand.name = 'Stand';
    this.avatarRoot.add(this.stand);

    this.marker = this.createMarker();
    this.marker.visible = false;
    this.scene.add(this.marker);

    this.resize();
    this.applyLighting();
    this.applyBackground();
  }

  private createMarker() {
    const g = new THREE.Group();
    g.name = 'LightMarker';
    const mat = new THREE.MeshBasicMaterial({ color: 0xffd34d, depthTest: false, transparent: true, opacity: 0.95 });
    const sun = new THREE.Mesh(new THREE.SphereGeometry(0.04, 16, 12), mat);
    g.add(sun);
    for (let i = 0; i < 8; i++) {
      const ray = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.035, 0.008), mat);
      const a = (i / 8) * Math.PI * 2;
      ray.position.set(Math.cos(a) * 0.075, Math.sin(a) * 0.075, 0);
      ray.rotation.z = a - Math.PI / 2;
      g.add(ray);
    }
    const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -0.35)]);
    const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xffd34d, depthTest: false }));
    g.add(line);
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.025, 0.07, 12), mat);
    cone.rotation.x = -Math.PI / 2;
    cone.position.z = -0.37;
    g.add(cone);
    g.traverse((o) => {
      o.layers.set(HELPER_LAYER);
      o.renderOrder = 999;
    });
    return g;
  }

  resize() {
    const w = Math.max(1, window.innerWidth);
    const hgt = Math.max(1, window.innerHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * (general.pixelRatio || 1);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, hgt, false);
    this.rig.camera.aspect = w / hgt;
    this.rig.camera.updateProjectionMatrix();
  }

  setTransparent(on: boolean) {
    this.transparent = on;
    this.applyBackground();
  }

  applyBackground() {
    const c = new THREE.Color(general.background);
    const k = 0.35 + 0.65 * lighting.brightness;
    c.multiplyScalar(k);
    if (this.transparent) {
      this.scene.background = null;
      this.renderer.setClearColor(0x000000, 0);
    } else {
      this.scene.background = c;
      this.renderer.setClearColor(c, 1);
    }
    document.body.classList.toggle('transparent', this.transparent);
  }

  /** Light direction in world space (unit vector from target toward the light). */
  lightDirection(out = new THREE.Vector3()) {
    const az = THREE.MathUtils.degToRad(lighting.azimuth);
    const el = THREE.MathUtils.degToRad(lighting.elevation);
    out.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
    if (lighting.lock === 'avatar') out.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.avatarRoot.rotation.y);
    return out;
  }

  applyLighting() {
    const color = kelvinToColor(lighting.temperature);
    this.mainLight.color.copy(color);
    this.mainLight.intensity = Math.PI * lighting.brightness;
    this.ambient.color.copy(color);
    this.ambient.intensity = 0.35 + 0.9 * lighting.brightness;
    this.marker.visible = lighting.marker;
    this.applyBackground();
  }

  setPreset(p: keyof typeof LIGHT_PRESETS | 'custom') {
    lighting.preset = p;
    if (p === 'custom') {
      if (lighting.custom) Object.assign(lighting, lighting.custom);
    } else {
      lighting.azimuth = LIGHT_PRESETS[p].azimuth;
      lighting.elevation = LIGHT_PRESETS[p].elevation;
    }
    lighting.save();
    this.applyLighting();
  }

  resetLighting() {
    Object.assign(lighting, LIGHT_DEFAULTS, { preset: 'default' });
    lighting.save();
    this.applyLighting();
  }

  /** Per-frame light placement relative to the avatar. */
  updateLight(center: THREE.Vector3, radius: number) {
    const dir = this.lightDirection();
    this.lightTarget.position.copy(center);
    this.mainLight.position.copy(center).addScaledVector(dir, 5);
    if (this.marker.visible) {
      // The marker's arrow points along local -Z: aim it from the light toward the avatar.
      this.marker.position.copy(center).addScaledVector(dir, Math.max(0.6, radius * 1.2));
      this.marker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir.clone().negate());
    }
  }

  updateStand(footY: number, scale: number) {
    this.stand.visible = general.stand;
    const r = this.standBaseRadius * scale;
    this.stand.scale.set(r, 1, r);
    this.stand.position.y = footY;
  }

  render(camera = this.rig.camera) {
    this.renderer.render(this.scene, camera);
  }
}
