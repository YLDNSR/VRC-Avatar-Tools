// Syphon output: renders the scene off-screen (without UI and helpers), reads it back
// asynchronously and hands BGRA frames to the main process Syphon server.
import * as THREE from 'three';
import { HELPER_LAYER, type Stage } from './stage';
import { streaming as settings } from './settings';
import type { ViewerBridge } from '../shared/bridge';

const vav = (window as any).vav as ViewerBridge;

const POST_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const POST_FRAG = /* glsl */ `
uniform sampler2D tSrc;
varying vec2 vUv;
vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
void main() {
  // Flip vertically so rows come back top-down, un-premultiply, encode sRGB, swap to BGRA.
  vec4 c = texture2D(tSrc, vec2(vUv.x, 1.0 - vUv.y));
  float a = clamp(c.a, 0.0, 1.0);
  vec3 rgb = a > 0.0001 ? c.rgb / a : vec3(0.0);
  rgb = toSRGB(clamp(rgb, 0.0, 1.0));
  gl_FragColor = vec4(rgb.b, rgb.g, rgb.r, a);
}
`;

export function parseResolution(res: string, stage: Stage): [number, number] {
  if (res === 'window') {
    const size = stage.renderer.getDrawingBufferSize(new THREE.Vector2());
    return [Math.max(16, Math.round(size.x)), Math.max(16, Math.round(size.y))];
  }
  const m = /^(\d+)x(\d+)$/.exec(res);
  if (!m) return [1920, 1080];
  return [parseInt(m[1], 10), parseInt(m[2], 10)];
}

export class SyphonOutput {
  running = false;
  available = true;
  clients = false;
  private sceneRT: THREE.WebGLRenderTarget | null = null;
  private outRT: THREE.WebGLRenderTarget | null = null;
  private postScene = new THREE.Scene();
  private postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private postMat: THREE.ShaderMaterial;
  private outCam = new THREE.PerspectiveCamera();
  private inFlight = 0;
  private lastFrame = 0;
  private statusTimer = 0;
  framesSent = 0;
  onStatus?: () => void;

  constructor() {
    this.postMat = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null } },
      vertexShader: POST_VERT,
      fragmentShader: POST_FRAG,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      blending: THREE.NoBlending,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.postMat);
    quad.frustumCulled = false;
    this.postScene.add(quad);
  }

  async start() {
    const ok = await vav.syphon.start(settings.syphonName || 'VRC Avatar Tools');
    this.available = ok;
    this.running = ok;
    clearInterval(this.statusTimer);
    if (ok) {
      this.statusTimer = window.setInterval(async () => {
        const s = await vav.syphon.status();
        if (s.clients !== this.clients) { this.clients = s.clients; this.onStatus?.(); }
      }, 1000);
    }
    this.onStatus?.();
    return ok;
  }

  async stop() {
    this.running = false;
    clearInterval(this.statusTimer);
    this.clients = false;
    await vav.syphon.stop();
    this.disposeTargets();
    this.onStatus?.();
  }

  private disposeTargets() {
    this.sceneRT?.dispose();
    this.outRT?.dispose();
    this.sceneRT = null;
    this.outRT = null;
  }

  private ensureTargets(w: number, h: number) {
    if (this.sceneRT && this.sceneRT.width === w && this.sceneRT.height === h) return;
    this.disposeTargets();
    this.sceneRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4, depthBuffer: true });
    this.outRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, depthBuffer: false });
  }

  /** Whether a frame is due (used by the idle-FPS logic to keep rendering). */
  due(now: number) {
    return this.running && now - this.lastFrame >= 1000 / Math.max(1, settings.syphonFps) - 2;
  }

  capture(stage: Stage, now: number) {
    if (!this.due(now) || this.inFlight >= 2) return;
    this.lastFrame = now;
    const [w, h] = parseResolution(settings.syphonResolution, stage);
    this.ensureTargets(w, h);
    const r = stage.renderer;
    const cam = this.outCam;
    cam.copy(stage.rig.camera);
    cam.aspect = w / h;
    cam.updateProjectionMatrix();
    cam.layers.disable(HELPER_LAYER);

    const prevTarget = r.getRenderTarget();
    r.setRenderTarget(this.sceneRT);
    r.clear();
    r.render(stage.scene, cam);
    this.postMat.uniforms.tSrc.value = this.sceneRT!.texture;
    r.setRenderTarget(this.outRT);
    r.render(this.postScene, this.postCam);
    r.setRenderTarget(prevTarget);

    const buf = new Uint8Array(w * h * 4);
    this.inFlight++;
    r.readRenderTargetPixelsAsync(this.outRT!, 0, 0, w, h, buf)
      .then(() => {
        if (this.running) {
          vav.syphon.sendFrame(buf, w, h);
          this.framesSent++;
        }
      })
      .catch(() => { /* context lost or resized */ })
      .finally(() => { this.inFlight--; });
  }
}
