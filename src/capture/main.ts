// VRC Avatar Tools Capture (macOS): webcam / iFacialMocap → VMC + VRChat OSC.
import * as THREE from 'three';
import './styles.css';
import { cap, type ExprFormat } from './settings';
import { resolveLang, setLang, t, LANGS } from '../shared/i18n';
import { h, clear, icon, slider, toggle, select, numberInput, textInput, segmented, toast } from '../shared/dom';
import { Tracker, type TrackFrame } from './tracker';
import { BodySolver, headFromMatrix, type HandObs, type LM } from './solver';
import { FaceMapper, swapLeftRight, vowelsFromArkit, eyeRotation } from './faceMap';
import { LipSync } from './lipsync';
import { IfmReceiver, ifmHeadRotation } from './ifm';
import { Sender } from './sender';
import { arkitToVrcft, ARKIT_NAMES } from '../shared/face';
import type { CaptureBridge } from '../shared/bridge';

const vav = (window as any).vav as CaptureBridge;
setLang(resolveLang(cap.language));

const I = new THREE.Quaternion();
const tracker = new Tracker();
const solver = new BodySolver();
const faceMapper = new FaceMapper();
const ifm = new IfmReceiver();
const lipsync = new LipSync();
const sender = new Sender();

const state = {
  stream: null as MediaStream | null,
  cameraOn: false,
  loadingModels: false,
  calibrated: false,
  calibrating: 0,
  sending: false,
  vrchatOsc: cap.vrchatOsc,
  headCalib: null as THREE.Quaternion | null,
  headPosCalib: null as THREE.Vector3 | null,
  lastHeadW: new THREE.Quaternion(),
  lastHeadPos: new THREE.Vector3(),
  track: { face: false, pose: false, hands: 0, fps: 0 },
  frames: 0,
  fpsTime: performance.now(),
  lastFrameTime: performance.now(),
};

// ---------------------------------------------------------------------------
// Layout

const video = h('video', { playsinline: true, muted: true, autoplay: true }) as HTMLVideoElement;
const overlay = h('canvas', { class: 'overlay' }) as HTMLCanvasElement;
const placeholder = h('div', { class: 'placeholder' }, icon('camera', 48), h('div', {}, t('cap.noPreview')));
const countdownEl = h('div', { class: 'countdown hidden' });
const trackLine = h('div', { class: 'track-line muted' });
const sendLine = h('div', { class: 'send-line' });
const preview = h('div', { class: 'preview' }, video, overlay, placeholder, countdownEl);
const left = h('div', { class: 'left' }, preview, h('div', { class: 'status-bar' }, trackLine, sendLine), h('p', { class: 'privacy muted small' }, t('cap.privacy')));
const right = h('div', { class: 'right' });
const langSel = select('', LANGS.map((l) => ({ value: l.id, label: l.id === 'auto' ? 'Auto' : l.label })), cap.language, (v) => {
  cap.language = v; cap.save(); vav.setLanguage(v); setTimeout(() => location.reload(), 120);
});
const header = h('header', {},
  h('div', { class: 'title' }, icon('camera', 18), 'VRC Avatar Tools Capture'),
  h('div', { class: 'header-actions' }, langSel.el, h('button', { class: 'btn small', onclick: () => vav.openViewer() }, t('cap.openViewer'))),
);
document.body.append(header, h('main', {}, left, right));

function section(title: string, ...children: (Node | null)[]) {
  return h('section', { class: 'card' }, h('h3', {}, title), ...children.filter(Boolean) as Node[]);
}

// --- Camera section
const cameraSel = select(t('cap.camera'), [{ value: '', label: '…' }], cap.camera, (v) => {
  cap.camera = v; cap.save();
  if (v === 'none' && state.cameraOn) stopCamera();
  refresh();
});
const resSel = select(t('cap.resolution'), ['640x480', '1280x720', '1920x1080'].map((r) => ({ value: r, label: r.replace('x', ' × ') })), cap.resolution, (v) => { cap.resolution = v; cap.save(); });
const fpsSel = select(t('cap.fps'), [{ value: '30', label: '30' }, { value: '60', label: '60' }], String(cap.fps), (v) => { cap.fps = parseInt(v, 10); cap.save(); });
const modelSel = select(t('cap.model'), [{ value: 'lite', label: t('cap.model.lite') }, { value: 'full', label: t('cap.model.full') }], cap.model, async (v) => {
  cap.model = v as any; cap.save(); await tracker.setOptions(cap.model, cap.hands);
});
const handsToggle = toggle(t('cap.hands'), cap.hands, async (v) => { cap.hands = v; cap.save(); await tracker.setOptions(cap.model, cap.hands); });
const mirrorToggle = toggle(t('cap.mirror'), cap.mirror, (v) => { cap.mirror = v; cap.save(); solver.calib = null; });
const lmToggle = toggle(t('cap.landmarks'), cap.landmarks, (v) => { cap.landmarks = v; cap.save(); });
const camBtn = h('button', { class: 'btn primary', onclick: () => (state.cameraOn ? stopCamera() : startCamera()) }, t('cap.startCamera')) as HTMLButtonElement;

// --- iFacialMocap
const ifmIp = textInput(t('cap.ifmIp'), cap.ifmIp, (v) => { cap.ifmIp = v; cap.save(); if (cap.ifmUse) ifm.start(v); refresh(); }, '192.168.0.10');
const ifmToggle = toggle(t('cap.ifmUse'), cap.ifmUse, (v) => {
  cap.ifmUse = v; cap.save();
  if (v) ifm.start(cap.ifmIp); else ifm.stop();
  refresh();
});
const ifmStatus = h('div', { class: 'status' });

// --- Calibration
const countdownSel = select(t('cap.countdown'), [0, 3, 5, 10].map((n) => ({ value: String(n), label: t('cap.seconds', { n }) })), String(cap.countdown), (v) => { cap.countdown = parseInt(v, 10); cap.save(); });
const calibBtn = h('button', { class: 'btn primary', onclick: () => calibrate() }, t('cap.calibInitial')) as HTMLButtonElement;

// --- Motion adjustment
const adj = (label: string, get: () => number, setv: (v: number) => void, min = 0, max = 1, step = 0.01, fmt?: (v: number) => string) =>
  slider({ label, min, max, step, value: get(), format: fmt, onInput: (v) => { setv(v); cap.save(); configureSolver(); } });
const pct = (v: number) => `${Math.round(v * 100)}%`;
const adjustSliders = [
  h('div', { class: 'sub' }, t('cap.sec.upper')),
  adj(t('cap.p.stability'), () => cap.upper.stability, (v) => (cap.upper.stability = v), 0, 1, 0.01, pct).el,
  adj(t('cap.p.responsiveness'), () => cap.upper.responsiveness, (v) => (cap.upper.responsiveness = v), 0, 1, 0.01, pct).el,
  adj(t('cap.p.amount'), () => cap.upper.amount, (v) => (cap.upper.amount = v), 0, 1.5, 0.01, pct).el,
  h('div', { class: 'sub' }, t('cap.sec.arm')),
  adj(t('cap.p.stability'), () => cap.arm.stability, (v) => (cap.arm.stability = v), 0, 1, 0.01, pct).el,
  adj(t('cap.p.responsiveness'), () => cap.arm.responsiveness, (v) => (cap.arm.responsiveness = v), 0, 1, 0.01, pct).el,
  adj(t('cap.p.amount'), () => cap.arm.amount, (v) => (cap.arm.amount = v), 0, 1.5, 0.01, pct).el,
  h('div', { class: 'sub' }, t('cap.sec.hand')),
  adj(t('cap.p.handDepth'), () => cap.hand.depth, (v) => (cap.hand.depth = v), -1, 1, 0.01, (v) => v.toFixed(2)).el,
  h('div', { class: 'sub' }, t('cap.sec.eye')),
  adj(t('cap.p.amount'), () => cap.eye.amount, (v) => (cap.eye.amount = v), 0, 2, 0.01, pct).el,
  adj(t('cap.p.eyeVertical'), () => cap.eye.vertical, (v) => (cap.eye.vertical = v), -0.6, 0.6, 0.01, (v) => v.toFixed(2)).el,
  adj(t('cap.p.eyeClose'), () => cap.eye.close, (v) => (cap.eye.close = v), 0, 1, 0.01, pct).el,
  adj(t('cap.p.eyeOpen'), () => cap.eye.open, (v) => (cap.eye.open = v), 0, 1, 0.01, pct).el,
];

// --- Parts
const parts = (['face', 'head', 'arms', 'upper', 'lower'] as const).map((p) =>
  toggle(t(`cap.part.${p}`), cap.parts[p], (v) => { cap.parts[p] = v; cap.save(); }));

// --- Lip sync
const lipToggle = toggle(t('cap.lipsyncOn'), cap.lipsync, async (v) => {
  cap.lipsync = v; cap.save();
  if (v) await startLipsync(); else await lipsync.stop();
});
const micSel = select(t('cap.mic'), [{ value: '', label: 'Default' }], cap.mic, async (v) => {
  cap.mic = v; cap.save();
  if (cap.lipsync) await startLipsync();
});
const meter = h('div', { class: 'meter' }, h('div', { class: 'meter-fill' }));

// --- Output
const destIp = textInput(t('cap.destIp'), cap.destIp, (v) => { cap.destIp = v || '127.0.0.1'; cap.save(); });
const vmcPort = numberInput(t('cap.vmcPort'), cap.vmcPort, (v) => { cap.vmcPort = v; cap.save(); }, { min: 1, max: 65535, width: '90px' });
const oscPort = numberInput(t('cap.oscPort'), cap.oscPort, (v) => { cap.oscPort = v; cap.save(); sender.resetOsc(); }, { min: 1, max: 65535, width: '90px' });
const formatSeg = segmented<ExprFormat>([
  { value: 'vrm', label: t('cap.format.vrm') },
  { value: 'ps', label: 'Perfect Sync' },
  { value: 'vrcft', label: 'VRCFT' },
], cap.format, (v) => { cap.format = v; cap.save(); sender.resetOsc(); refresh(); });
const sendBtn = h('button', { class: 'btn primary big', onclick: () => toggleSend() }, t('cap.startSend')) as HTMLButtonElement;
const sendCaption = h('div', { class: 'caption' });
const vrchatBtn = h('button', { class: 'btn', onclick: () => { state.vrchatOsc = !state.vrchatOsc; cap.vrchatOsc = state.vrchatOsc; cap.save(); sender.resetOsc(); refresh(); } }, t('cap.vrchatOsc')) as HTMLButtonElement;
const vrchatIp = textInput(t('cap.vrchatTarget'), cap.vrchatIp, (v) => { cap.vrchatIp = v || '127.0.0.1'; cap.save(); });

right.append(
  section(t('cap.camera'), cameraSel.el, resSel.el, fpsSel.el, modelSel.el, handsToggle.el, mirrorToggle.el, lmToggle.el, camBtn),
  section('iFacialMocap', ifmIp.el, ifmToggle.el, ifmStatus),
  section(t('cap.calibInitial'), countdownSel.el, calibBtn),
  section(t('cap.adjust'), ...adjustSliders),
  section(t('cap.parts'), ...parts.map((p) => p.el)),
  section(t('cap.lipsync'), lipToggle.el, micSel.el, meter),
  section(t('cap.send'), destIp.el, vmcPort.el, oscPort.el, h('div', { class: 'row-label' }, t('cap.format')), formatSeg.el, sendBtn, sendCaption,
    h('div', { class: 'divider' }), h('div', { class: 'row-label' }, t('cap.vrchatOscHint')), vrchatIp.el, vrchatBtn),
);

function configureSolver() {
  solver.configure({ mirror: cap.mirror, lowerBody: cap.parts.lower, upper: cap.upper, arm: cap.arm, handDepth: cap.hand.depth });
}
configureSolver();

// ---------------------------------------------------------------------------
// Devices

async function listDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter((d) => d.kind === 'videoinput');
  const mics = devices.filter((d) => d.kind === 'audioinput');
  const camOpts = cams.map((d, i) => ({ value: d.deviceId, label: d.label || `Camera ${i + 1}` }));
  camOpts.push({ value: 'none', label: t('cap.noCamera') });
  if (!cap.camera || (cap.camera !== 'none' && !cams.some((c) => c.deviceId === cap.camera))) cap.camera = cams[0]?.deviceId || 'none';
  cameraSel.setOptions(camOpts, cap.camera);
  micSel.setOptions([{ value: '', label: 'Default' }, ...mics.map((d, i) => ({ value: d.deviceId, label: d.label || `Mic ${i + 1}` }))], cap.mic);
}
navigator.mediaDevices.addEventListener('devicechange', () => listDevices());

async function ensureTracker() {
  if (tracker.ready || state.loadingModels) return tracker.ready;
  state.loadingModels = true;
  trackLine.textContent = t('cap.loadingModels');
  try {
    await tracker.init(cap.model, cap.hands);
  } catch (err) {
    toast(t('cap.modelError', { msg: (err as Error).message || String(err) }), 8000);
    console.error(err);
  }
  state.loadingModels = false;
  return tracker.ready;
}

async function startCamera() {
  if (cap.camera === 'none') { toast(t('cap.noCamera')); return; }
  if (!(await vav.requestMedia('camera'))) { toast(t('cap.cameraDenied'), 8000); return; }
  const [w, hgt] = cap.resolution.split('x').map((n) => parseInt(n, 10));
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: cap.camera ? { exact: cap.camera } : undefined, width: { ideal: w }, height: { ideal: hgt }, frameRate: { ideal: cap.fps } },
      audio: false,
    });
  } catch (err) {
    toast(`${t('cap.cameraDenied')} (${(err as Error).message})`, 8000);
    return;
  }
  await listDevices();
  video.srcObject = state.stream;
  await video.play().catch(() => {});
  state.cameraOn = true;
  refresh();
  if (await ensureTracker()) scheduleVideoFrame();
}

function stopCamera() {
  state.stream?.getTracks().forEach((tr) => tr.stop());
  state.stream = null;
  video.srcObject = null;
  state.cameraOn = false;
  if (state.sending && cap.camera !== 'none') stopSend();
  refresh();
}

async function startLipsync() {
  if (!(await vav.requestMedia('microphone'))) { toast(t('cap.micDenied'), 8000); lipToggle.set(false); cap.lipsync = false; cap.save(); return; }
  try {
    await lipsync.start(cap.mic);
    await listDevices();
  } catch (err) {
    toast(`${t('cap.micDenied')} (${(err as Error).message})`, 8000);
  }
}

// ---------------------------------------------------------------------------
// Calibration

function calibrate() {
  const ready = state.cameraOn || ifm.active();
  if (!ready) { toast(t('cap.needSource')); return; }
  let n = cap.countdown;
  const finish = () => {
    solver.calibrate();
    faceMapper.calibrate();
    state.headCalib = state.lastHeadW.clone().invert();
    state.headPosCalib = state.lastHeadPos.clone();
    state.calibrated = true;
    state.calibrating = 0;
    countdownEl.classList.add('hidden');
    toast(t('cap.calibrated'));
    refresh();
  };
  if (n <= 0) { finish(); return; }
  state.calibrating = n;
  countdownEl.classList.remove('hidden');
  countdownEl.textContent = t('cap.calibrating', { n });
  const timer = setInterval(() => {
    n--;
    if (n <= 0) { clearInterval(timer); finish(); return; }
    state.calibrating = n;
    countdownEl.textContent = t('cap.calibrating', { n });
  }, 1000);
}

// ---------------------------------------------------------------------------
// Sending

function canSend() {
  if (!state.calibrated) return t('cap.needCalib');
  if (cap.camera === 'none' ? !ifm.active() : !state.cameraOn) return t('cap.needSource');
  return null;
}

function toggleSend() {
  if (state.sending) { stopSend(); return; }
  const why = canSend();
  if (why) { toast(why); return; }
  state.sending = true;
  sender.resetOsc();
  refresh();
}

function stopSend() {
  state.sending = false;
  refresh();
}

// IFM-only mode has no video frames: drive the pipeline from a timer.
setInterval(() => {
  if (!state.cameraOn && ifm.active()) process(null, performance.now());
  if (lipsync.running) {
    lipsync.update();
    (meter.firstChild as HTMLElement).style.width = `${Math.round(lipsync.level * 100)}%`;
  }
}, 1000 / 60);

// ---------------------------------------------------------------------------
// Per-frame pipeline

function scheduleVideoFrame() {
  if (!state.cameraOn) return;
  const cb = () => {
    if (!state.cameraOn) return;
    try {
      const frame = tracker.detect(video, true);
      process(frame, frame.time);
      draw(frame);
    } catch (err) {
      console.error(err);
    }
    scheduleVideoFrame();
  };
  if ('requestVideoFrameCallback' in video) (video as any).requestVideoFrameCallback(cb);
  else requestAnimationFrame(cb);
}

function assignHands(frame: TrackFrame): HandObs[] {
  const res = frame.hands;
  if (!res || !res.worldLandmarks?.length) return [];
  const pose = frame.pose?.landmarks?.[0];
  const out: HandObs[] = [];
  res.worldLandmarks.forEach((world, i) => {
    const image = res.landmarks[i];
    const label = res.handedness?.[i]?.[0]?.categoryName || '';
    // Which of the person's hands is it? Prefer the nearest pose wrist.
    let personSide: 'left' | 'right' = label === 'Left' ? 'right' : 'left';
    if (pose) {
      const dl = Math.hypot(image[0].x - pose[15].x, image[0].y - pose[15].y);
      const dr = Math.hypot(image[0].x - pose[16].x, image[0].y - pose[16].y);
      personSide = dl < dr ? 'left' : 'right';
    }
    const avatarSide = cap.mirror ? (personSide === 'left' ? 'right' : 'left') : personSide;
    out.push(Object.assign({ world: world as LM[], image: image as LM[], label }, { side: avatarSide }));
  });
  return out;
}

const ARMS_DOWN_L = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(-72));
const ARMS_DOWN_R = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(72));

function process(frame: TrackFrame | null, now: number) {
  const dt = Math.min(0.1, Math.max(0.001, (now - state.lastFrameTime) / 1000));
  state.lastFrameTime = now;
  state.frames++;
  if (now - state.fpsTime > 1000) {
    state.track.fps = Math.round((state.frames * 1000) / (now - state.fpsTime));
    state.frames = 0;
    state.fpsTime = now;
    updateStatusLines();
  }

  const bones = new Map<string, THREE.Quaternion>();
  const useIfm = ifm.active() && !!ifm.last;
  configureSolver();

  // --- Body
  const poseWorld = frame?.pose?.worldLandmarks?.[0] as LM[] | undefined;
  const poseImage = frame?.pose?.landmarks?.[0] as LM[] | undefined;
  state.track.pose = !!poseWorld;
  state.track.hands = frame?.hands?.landmarks?.length || 0;
  const body = solver.solve(poseWorld || null, poseImage || null, frame ? assignHands(frame) : [], {
    mirror: cap.mirror, lowerBody: cap.parts.lower, upper: cap.upper, arm: cap.arm, handDepth: cap.hand.depth,
  }, dt);
  if (cap.parts.upper) for (const b of ['spine', 'chest']) bones.set(b, body.bones.get(b) || I.clone());
  else for (const b of ['spine', 'chest']) bones.set(b, I.clone());
  bones.set('hips', cap.parts.lower && body.bones.get('hips') ? body.bones.get('hips')! : I.clone());
  if (cap.parts.arms) {
    for (const [k, q] of body.bones) if (/Arm|Hand|Thumb|Index|Middle|Ring|Little/.test(k)) bones.set(k, q);
    if (!body.bodyValid) { bones.set('leftUpperArm', ARMS_DOWN_L.clone()); bones.set('rightUpperArm', ARMS_DOWN_R.clone()); }
  } else {
    bones.set('leftUpperArm', ARMS_DOWN_L.clone());
    bones.set('rightUpperArm', ARMS_DOWN_R.clone());
    for (const b of ['leftLowerArm', 'rightLowerArm', 'leftHand', 'rightHand']) bones.set(b, I.clone());
  }
  if (cap.parts.lower) {
    for (const [k, q] of body.bones) if (/Leg|Foot/.test(k)) bones.set(k, q);
  } else {
    for (const b of ['leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg']) bones.set(b, I.clone());
  }

  // --- Head
  let headW: THREE.Quaternion | null = null;
  let headPos: THREE.Vector3 | null = null;
  if (useIfm && ifm.last!.headEuler) {
    headW = ifmHeadRotation(ifm.last!.headEuler, cap.mirror);
    if (ifm.last!.headPos) {
      const p = ifm.last!.headPos;
      headPos = new THREE.Vector3((cap.mirror ? 1 : -1) * p[0], p[1], p[2]).multiplyScalar(0.01);
    }
  } else if (frame?.face?.facialTransformationMatrixes?.length) {
    const r = headFromMatrix(frame.face.facialTransformationMatrixes[0].data, cap.mirror);
    headW = r.rot;
    headPos = r.pos;
  }
  state.track.face = !!headW;
  const rootPos = new THREE.Vector3();
  if (headW) {
    state.lastHeadW.copy(headW);
    if (headPos) state.lastHeadPos.copy(headPos);
    const hw = state.headCalib ? state.headCalib.clone().multiply(headW) : headW.clone();
    if (cap.parts.head) {
      const chestW = bones.get('hips')!.clone().multiply(bones.get('spine')!).multiply(bones.get('chest')!);
      const rel = chestW.clone().invert().multiply(hw);
      const neck = I.clone().slerp(rel, 0.35);
      bones.set('neck', neck);
      bones.set('head', neck.clone().invert().multiply(rel));
    }
    if (headPos && state.headPosCalib && cap.parts.upper) {
      const d = headPos.clone().sub(state.headPosCalib);
      rootPos.set(THREE.MathUtils.clamp(d.x * 0.5, -0.3, 0.3), THREE.MathUtils.clamp(d.y * 0.25, -0.15, 0.15), THREE.MathUtils.clamp(d.z * 0.6, -0.4, 0.4));
    }
  } else if (cap.parts.head) {
    bones.set('neck', I.clone());
    bones.set('head', I.clone());
  }

  // --- Face
  let shapes: Record<string, number> | null = null;
  if (useIfm) shapes = { ...ifm.last!.shapes };
  else if (frame?.face?.faceBlendshapes?.length) {
    shapes = {};
    for (const c of frame.face.faceBlendshapes[0].categories) shapes[c.categoryName] = c.score;
  }
  const blends: Record<string, number> = {};
  let oscParams: Record<string, number> | null = null;
  if (shapes && cap.parts.face) {
    if (cap.mirror) shapes = swapLeftRight(shapes);
    const { shapes: a, gaze } = faceMapper.process(shapes, cap.eye);
    if (lipsync.running && cap.lipsync) {
      const v = lipsync.vowels;
      a.jawOpen = Math.min(1, v.A * 0.9 + v.O * 0.6 + v.E * 0.4 + v.I * 0.2 + v.U * 0.15);
      a.mouthFunnel = v.O * 0.8;
      a.mouthPucker = v.U * 0.9;
      a.mouthStretchLeft = a.mouthStretchRight = v.I * 0.6 + v.E * 0.4;
      a.mouthSmileLeft = Math.max(a.mouthSmileLeft || 0, v.I * 0.3);
      a.mouthSmileRight = Math.max(a.mouthSmileRight || 0, v.I * 0.3);
    }
    // eyes as bones (gaze)
    const eyeQ = eyeRotation(gaze);
    bones.set('leftEye', eyeQ);
    bones.set('rightEye', eyeQ.clone());
    if (cap.format === 'vrm') {
      const vow = lipsync.running && cap.lipsync ? lipsync.vowels : vowelsFromArkit(a);
      blends.Blink_L = a.eyeBlinkLeft || 0;
      blends.Blink_R = a.eyeBlinkRight || 0;
      blends.Blink = Math.min(blends.Blink_L, blends.Blink_R);
      if (blends.Blink > 0.5) { blends.Blink_L -= blends.Blink; blends.Blink_R -= blends.Blink; }
      else blends.Blink = 0;
      blends.A = vow.A; blends.I = vow.I; blends.U = vow.U; blends.E = vow.E; blends.O = vow.O;
      for (const n of ['browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight']) blends[n] = a[n] || 0;
    } else if (cap.format === 'ps') {
      for (const n of ARKIT_NAMES) blends[n] = a[n] || 0;
    }
    if (cap.format === 'vrcft' || state.vrchatOsc) {
      // VRCFT eye X: +1 = look right (avatar's right is -X in avatar space)
      oscParams = arkitToVrcft(a, { x: -gaze.x, y: gaze.y });
    }
  }

  if (state.sending) {
    sender.sendVmc(cap.destIp, cap.vmcPort, { bones, rootPos, blends });
  }
  if (oscParams) {
    const targets = new Set<string>();
    if (state.sending && cap.format === 'vrcft') targets.add(`${cap.destIp}:${cap.oscPort}`);
    if (state.vrchatOsc) targets.add(`${cap.vrchatIp}:${cap.oscPort}`);
    for (const tgt of targets) {
      const [host, port] = tgt.split(':');
      sender.sendVrcft(host, parseInt(port, 10), oscParams, targets.size > 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Preview drawing

const POSE_LINKS = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28], [15, 17], [15, 19], [16, 18], [16, 20]];
const HAND_LINKS = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [0, 9], [9, 10], [10, 11], [11, 12], [0, 13], [13, 14], [14, 15], [15, 16], [0, 17], [17, 18], [18, 19], [19, 20], [5, 9], [9, 13], [13, 17]];

function draw(frame: TrackFrame) {
  const w = video.videoWidth, hgt = video.videoHeight;
  if (!w) return;
  if (overlay.width !== w || overlay.height !== hgt) { overlay.width = w; overlay.height = hgt; }
  const g = overlay.getContext('2d')!;
  g.clearRect(0, 0, w, hgt);
  if (!cap.landmarks) return;
  const X = (x: number) => x * w;
  const Y = (y: number) => y * hgt;
  const pose = frame.pose?.landmarks?.[0];
  if (pose) {
    g.strokeStyle = 'rgba(108,140,255,0.9)';
    g.lineWidth = 3;
    for (const [a, b] of POSE_LINKS) {
      if ((pose[a].visibility ?? 1) < 0.4 || (pose[b].visibility ?? 1) < 0.4) continue;
      g.beginPath(); g.moveTo(X(pose[a].x), Y(pose[a].y)); g.lineTo(X(pose[b].x), Y(pose[b].y)); g.stroke();
    }
  }
  for (const hand of frame.hands?.landmarks || []) {
    g.strokeStyle = 'rgba(69,212,131,0.9)';
    g.lineWidth = 2;
    for (const [a, b] of HAND_LINKS) { g.beginPath(); g.moveTo(X(hand[a].x), Y(hand[a].y)); g.lineTo(X(hand[b].x), Y(hand[b].y)); g.stroke(); }
  }
  const face = frame.face?.faceLandmarks?.[0];
  if (face) {
    g.fillStyle = 'rgba(255,211,77,0.85)';
    for (let i = 0; i < face.length; i += 6) { g.fillRect(X(face[i].x) - 1, Y(face[i].y) - 1, 2, 2); }
  }
}

// ---------------------------------------------------------------------------
// Status / refresh

function updateStatusLines() {
  const yes = t('cap.yes'), no = t('cap.no');
  trackLine.textContent = state.cameraOn
    ? t('cap.trackState', { f: state.track.face ? yes : no, p: state.track.pose ? yes : no, h: state.track.hands, fps: state.track.fps })
    : (ifm.active() ? `iFacialMocap · ${state.track.fps} fps` : '');
  sendLine.textContent = state.sending || state.vrchatOsc ? t('cap.sending', { pps: sender.pps }) : t('cap.notSending');
  sendLine.classList.toggle('on', state.sending || state.vrchatOsc);
}
setInterval(updateStatusLines, 1000);

function refresh() {
  const noCam = cap.camera === 'none';
  camBtn.textContent = state.cameraOn ? t('cap.stopCamera') : t('cap.startCamera');
  camBtn.disabled = noCam;
  camBtn.classList.toggle('danger', state.cameraOn);
  placeholder.classList.toggle('hidden', state.cameraOn);
  video.classList.toggle('mirror', cap.mirror);
  overlay.classList.toggle('mirror', cap.mirror);
  calibBtn.textContent = state.calibrated ? t('cap.calibRe') : t('cap.calibInitial');
  // iFacialMocap status
  const st = !cap.ifmUse ? 'stopped' : !cap.ifmIp ? 'noIp' : ifm.status === 'stopped' ? 'stopped' : ifm.status;
  clear(ifmStatus);
  ifmStatus.className = `status ${st === 'receiving' ? 'receiving' : st === 'waiting' ? 'waiting' : ''}`;
  ifmStatus.append(h('span', { class: 'dot' }), t(`cap.ifm.${st}`));
  if (ifm.error) ifmStatus.append(h('span', { class: 'error' }, ` ${t('cap.ifm.portError')} (${ifm.error})`));
  sendBtn.textContent = state.sending ? t('cap.stopSend') : t('cap.startSend');
  sendBtn.classList.toggle('danger', state.sending);
  sendCaption.textContent = t('cap.sendType', { type: cap.format === 'vrcft' ? 'VMC + VRChat OSC' : 'VMC' });
  vrchatBtn.classList.toggle('primary', state.vrchatOsc);
  vrchatBtn.textContent = `${t('cap.vrchatOsc')}: ${state.vrchatOsc ? 'ON' : 'OFF'}`;
  formatSeg.set(cap.format);
  updateStatusLines();
}
ifm.onStatus = () => refresh();

(async () => {
  await listDevices().catch(() => {});
  if (cap.ifmUse) ifm.start(cap.ifmIp);
  if (cap.lipsync) startLipsync();
  refresh();
  // Warm up the models in the background so the first camera start is quick.
  ensureTracker().then(() => updateStatusLines());
  (window as any).__cap = { state, cap, process, solver, faceMapper, sender, ifm, tracker };
})();
