// Viewer window entry point.
import * as THREE from 'three';
import './styles.css';
import { Stage } from './stage';
import { Avatar } from './avatar';
import { AnimationPlayer, animItemFromPath, isAnimationPath } from './animation';
import { GestureController } from './gestures';
import { createVrcRuntime, parseVavMeta, sidecarPath, type VavMeta } from './vrcMeta';
import { VrcAnimator } from './vrcAnimator';
import { StreamingInput } from './streaming';
import { SyphonOutput } from './syphon';
import { general, transparentSettings, animation as animSettings, streaming as streamSettings, type ModKey } from './settings';
import { resolveLang, setLang, t } from '../shared/i18n';
import { h, icon, toast } from '../shared/dom';
import type { App, AutocastHandle } from './app';
import type { CursorInfo, ViewerBridge } from '../shared/bridge';
import { createWelcome } from './ui/welcome';
import { createFolderBrowser } from './ui/folder';
import { createToolbar } from './ui/toolbar';
import { createAnimationPanel } from './ui/animationPanel';
import { createLayoutPanel } from './ui/layoutPanel';
import { createRadialMenu } from './ui/radialMenu';
import { layoutSettings, layoutKey, captureLayout, applyLayout, resetLayout } from './layout';
import { avatarStates, type AvatarState } from './avatarState';
import { createSettingsPanel } from './ui/settingsPanel';
import { createLightingPanel } from './ui/lightingPanel';
import { createStreamingPanel } from './ui/streamingPanel';
import { createFacePanel } from './ui/facePanel';
import { createParamsPanel } from './ui/paramsPanel';
import { createInfoOverlay } from './ui/infoOverlay';
import { autocastFlag } from './autocast/flag';
import { mateFlag } from './mate/flag';
import type { MateModule } from './mate';

const vav = (window as any).vav as ViewerBridge;
setLang(resolveLang(general.language));

const canvas = h('canvas', { id: 'scene' }) as HTMLCanvasElement;
const uiRoot = h('div', { id: 'ui' });
const loading = h('div', { id: 'loading', class: 'hidden' }, h('div', { class: 'spinner' }), h('span', { class: 'text' }));
const dragBar = h('div', { id: 'drag-bar' });
// Windows: the window is frameless (transparent), so the page draws minimize / close itself.
if (vav.platform === 'win32') {
  document.body.classList.add('platform-win');
  dragBar.append(h('div', { class: 'win-controls' },
    h('button', { class: 'win-btn', title: t('win.minimize'), onclick: () => vav.win.minimize() }, '\u2013'),
    h('button', { class: 'win-btn close', title: t('win.close'), onclick: () => vav.win.close() }, '\u2715')));
}
document.body.append(canvas, dragBar, uiRoot, loading);
// The beta app (separate settings) is told apart in window lists, e.g. OBS window capture.
if (vav.channel === 'beta') document.title = 'VRC Avatar Tools Beta';

const stage = new Stage(canvas);
const player = new AnimationPlayer();
player.onStateChange = () => rememberAvatarState();
const gestures = new GestureController();
const streaming = new StreamingInput();
const syphon = new SyphonOutput();

interface Panel { el: HTMLElement; refresh(): void; onShow?(): void }
const panels = new Map<string, Panel>();

const app: App = {
  stage, avatar: null, vrc: null, player, gestures, streaming, syphon,
  profiles: [], profileErrors: [], sysInfo: null, fps: 0,
  transparent: false, mateMode: false, view: 'welcome', cameFromFolder: false,
  loadAvatar, openAvatarDialog, openFolderDialog, rememberAvatarState, startWindowMove, centerAvatar, saveLayout, restoreLayout, resetLayout: resetLayoutCmd, setLayoutLocked,
  showWelcome, showFolder, setTransparent, setMateMode, applyTransparentOptions, toggleDesktopMate,
  markActive, rerenderUI, closePanels, togglePanel, reloadProfiles, applyProfile, faceFront,
  autocast: null, setAutocastEnabled, mate: null, setMateEnabled,
};
(window as any).__app = app; // for debugging from DevTools

// ---------------------------------------------------------------------------
// Views

const welcome = createWelcome(app);
const folder = createFolderBrowser(app);
const toolbar = createToolbar(app);
uiRoot.append(welcome.el, folder.el, toolbar.el);

function registerPanel(id: string, p: Panel) {
  panels.set(id, p);
  p.el.dataset.panel = id;
  p.el.classList.add('panel', 'hidden');
  uiRoot.appendChild(p.el);
}
registerPanel('animation', createAnimationPanel(app));
registerPanel('settings', createSettingsPanel(app));
registerPanel('lighting', createLightingPanel(app));
registerPanel('streaming', createStreamingPanel(app));
registerPanel('face', createFacePanel(app));
const paramsPanel = createParamsPanel(app);
registerPanel('params', paramsPanel);
const layoutPanel = createLayoutPanel(app);
registerPanel('layout', layoutPanel);
const info = createInfoOverlay(app);
uiRoot.appendChild(info.el);
// Right-click the avatar: the avatar menu as a ring around the cursor (also over a transparent background).
const radial = createRadialMenu(app);
uiRoot.appendChild(radial.el);

// Desktop character motion and autonomous broadcast (Settings → Labs): the mate module stays loaded so
// its UI section and Radial Menu entries are always accessible, while switching off stops its motion and
// takes its pose off the avatar.
let matePromise: Promise<MateModule> | null = null;
function loadMate() {
  matePromise ??= import('./mate').then((m) => m.createMate(app));
  matePromise.catch(() => { matePromise = null; });
  return matePromise;
}
function unloadMateIfUnused() {
  if (!app.mate || mateFlag.enabled || app.autocast) return;
  app.mate.shutdown();
}
async function setMateEnabled(on: boolean) {
  if (mateFlag.enabled !== on) { mateFlag.enabled = on; mateFlag.save(); }
  if (on) {
    try {
      app.mate = await loadMate();
      markActive();
    } catch (err) {
      console.error('[mate]', err);
      toast(`${t('set.mateFailed')}: ${(err as Error).message || err}`, 6000);
      mateFlag.enabled = false;
      mateFlag.save();
    }
  } else {
    unloadMateIfUnused();
  }
  rerenderUI();
}

async function toggleDesktopMate() {
  await setMateMode(!app.mateMode);
}

let autocastModule: AutocastHandle | null = null;
async function setAutocastEnabled(on: boolean) {
  if (autocastFlag.enabled !== on) { autocastFlag.enabled = on; autocastFlag.save(); }
  if (on) {
    try {
      const mate = await loadMate();
      app.mate = mate;
      if (!autocastModule) {
        const m = await import('./autocast');
        autocastModule = m.createAutocast(app, mate.life);
        registerPanel('autocast', autocastModule.panel);
      }
      app.autocast = autocastModule;
    } catch (err) {
      console.error('[autocast]', err);
      toast(`${t('set.autocastFailed')}: ${(err as Error).message || err}`, 6000);
      autocastFlag.enabled = false;
      autocastFlag.save();
      unloadMateIfUnused();
    }
  } else if (app.autocast) {
    app.autocast.shutdown();
    app.autocast = null;
    panels.get('autocast')?.el.classList.add('hidden');
    unloadMateIfUnused();
  }
  rerenderUI();
}
loadMate().then((m) => { app.mate = m; rerenderUI(); }).catch((err) => console.error('[mate]', err));
if (autocastFlag.enabled) setAutocastEnabled(true);

// Window / avatar move (radial menu → 아바타 이동 / 창 이동): drag the grip or the avatar; releasing ends it.
const moveGrip = h('div', { class: 'move-grip hidden' }, icon('move', 26), h('span', { class: 'move-grip-label' }, t('radial.moveHint')));
uiRoot.appendChild(moveGrip);
let windowMove: { dragging: boolean; x: number; y: number } | null = null;

function startWindowMove(x: number, y: number) {
  windowMove = { dragging: false, x: 0, y: 0 };
  Object.assign(moveGrip.style, {
    left: `${Math.min(Math.max(x, 50), window.innerWidth - 50)}px`,
    top: `${Math.min(Math.max(y, 50), window.innerHeight - 50)}px`,
  });
  moveGrip.classList.remove('hidden');
  document.body.classList.add('moving-window');
  updateClickThrough();
  markActive();
}

function endWindowMove() {
  if (!windowMove) return;
  windowMove = null;
  moveGrip.classList.add('hidden');
  document.body.classList.remove('moving-window');
  updateClickThrough();
}

function beginWindowDrag(e: PointerEvent, target: Element) {
  if (!windowMove) return;
  if (e.button !== 0) { endWindowMove(); return; }
  windowMove.dragging = true;
  windowMove.x = e.screenX;
  windowMove.y = e.screenY;
  try { target.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
}

moveGrip.addEventListener('pointerdown', (e) => { e.stopPropagation(); beginWindowDrag(e, moveGrip); });
moveGrip.addEventListener('contextmenu', (e) => { e.preventDefault(); endWindowMove(); });
window.addEventListener('pointermove', (e) => {
  if (!windowMove?.dragging) return;
  // Screen coordinates: the window moving under the pointer does not change them.
  const dx = e.screenX - windowMove.x;
  const dy = e.screenY - windowMove.y;
  if (!dx && !dy) return;
  windowMove.x = e.screenX;
  windowMove.y = e.screenY;
  vav.win.moveBy(dx, dy);
});
window.addEventListener('pointerup', () => { if (windowMove?.dragging) endWindowMove(); });

const MATE_ASPECT = 0.65;
let matePetHeight = 560;
let mateMaxHeight = 1400;
let mateResizeTimer: ReturnType<typeof setTimeout> | undefined;
let radialExpandedWindow = false;
let studioSnapshot: {
  rig: any;
  rot: THREE.Euler;
  pos: THREE.Vector3;
  scale: number;
  transparent: boolean;
} | null = null;

function syncMateWindowBounds(opts: { anchorX?: number; anchorY?: number; forceRadial?: boolean; restoreOnly?: boolean } = {}) {
  if (!app.mateMode) return null;
  clearTimeout(mateResizeTimer);
  mateResizeTimer = undefined;
  const anyPanelOpen = [...panels.values()].some((p) => !p.el.classList.contains('hidden'));
  const radialOpen = opts.forceRadial || radial.isOpen();
  const petH = Math.round(matePetHeight);
  const petW = Math.round(matePetHeight * MATE_ASPECT);

  if (anyPanelOpen) {
    const reqW = Math.max(petW + 390, 740);
    const reqH = Math.max(petH, 600);
    const r = vav.win.resizeMate({ width: reqW, height: reqH, petWidth: petW, petHeight: petH, expanded: true });
    if (r) {
      mateMaxHeight = Math.max(360, Math.round(r.workArea.height * 1.35));
      stage.rig.offsetX = r.charOffset.x;
      stage.rig.offsetY = r.charOffset.y;
    }
    stage.resize();
    stage.rig.apply();
    return r;
  }

  if (radialOpen && (petW < 330 || petH < 330)) {
    const reqW = Math.max(petW, 330);
    const reqH = Math.max(petH, 330);
    const r = vav.win.resizeMate({ width: reqW, height: reqH, petWidth: petW, petHeight: petH, expanded: true });
    if (r) {
      mateMaxHeight = Math.max(360, Math.round(r.workArea.height * 1.35));
      stage.rig.offsetX = r.charOffset.x;
      stage.rig.offsetY = r.charOffset.y;
    }
    stage.resize();
    stage.rig.apply();
    return r;
  }

  const r = vav.win.resizeMate({
    width: petW,
    height: petH,
    anchorX: opts.anchorX,
    anchorY: opts.anchorY,
    expanded: false,
    restoreOnly: opts.restoreOnly,
  });
  if (r) {
    mateMaxHeight = Math.max(360, Math.round(r.workArea.height * 1.35));
    stage.rig.offsetX = 0;
    stage.rig.offsetY = 0;
    stage.resize();
    stage.rig.apply();
  }
  return r;
}

(app as any).beforeRadialOpen = (x: number, y: number) => {
  if (!app.mateMode) return { x, y };
  const petW = Math.round(matePetHeight * MATE_ASPECT);
  const petH = Math.round(matePetHeight);
  if (window.innerWidth < 330 || window.innerHeight < 330 || petW < 330 || petH < 330) {
    radialExpandedWindow = true;
    const prevOffX = stage.rig.offsetX;
    const prevOffY = stage.rig.offsetY;
    syncMateWindowBounds({ forceRadial: true });
    return {
      x: x + (stage.rig.offsetX - prevOffX),
      y: y + (stage.rig.offsetY - prevOffY),
    };
  }
  radialExpandedWindow = false;
  return { x, y };
};

(app as any).afterRadialClose = () => {
  if (!app.mateMode || !radialExpandedWindow) return;
  radialExpandedWindow = false;
  queueMicrotask(() => {
    if (app.mateMode && !radial.isOpen()) {
      syncMateWindowBounds({ restoreOnly: true });
    }
  });
};

function centerAvatar() {
  if (layoutLocked()) return;
  stage.rig.offsetX = 0;
  stage.rig.offsetY = 0;
  stage.avatarRoot.position.x = 0;
  stage.avatarRoot.position.z = 0;
  if (app.mateMode && app.avatar) {
    stage.rig.frameForMate(app.avatar.restBox);
  }
  stage.rig.apply();
  rerenderUI();
  markActive();
}

function clampPanelsToViewport() {
  for (const p of panels.values()) {
    if (!p.el.style.left && !p.el.style.top) continue;
    if (!app.mateMode) {
      p.el.style.left = '';
      p.el.style.top = '';
      p.el.style.right = '';
      p.el.style.bottom = '';
      continue;
    }
    const r = p.el.getBoundingClientRect();
    const w = r.width || 300;
    const h = r.height || 360;
    const x = Math.min(Math.max(12, parseFloat(p.el.style.left) || 12), Math.max(12, window.innerWidth - w - 12));
    const y = Math.min(Math.max(36, parseFloat(p.el.style.top) || 36), Math.max(36, window.innerHeight - h - 12));
    p.el.style.left = `${x}px`;
    p.el.style.top = `${y}px`;
  }
}

function positionPanelNearAvatar(el: HTMLElement) {
  if (!app.mateMode) return;
  const ax = window.innerWidth * 0.5 + stage.rig.offsetX;
  const ay = window.innerHeight * 0.5 + stage.rig.offsetY;
  const r = el.getBoundingClientRect();
  const pw = r.width || 320;
  const ph = r.height || 400;
  const placeLeft = ax >= window.innerWidth * 0.5;
  const rawX = placeLeft ? 16 : Math.max(16, window.innerWidth - pw - 16);
  const rawY = ay - ph * 0.5;
  const x = Math.min(Math.max(14, rawX), Math.max(14, window.innerWidth - pw - 14));
  const y = Math.min(Math.max(24, rawY), Math.max(24, window.innerHeight - ph - 14));
  el.style.left = `${Math.round(x)}px`;
  el.style.top = `${Math.round(y)}px`;
  el.style.right = 'auto';
  el.style.bottom = 'auto';
}

function setView(v: App['view']) {
  app.view = v;
  if (v !== 'avatar') radial.close();
  welcome.el.classList.toggle('hidden', v !== 'welcome');
  folder.el.classList.toggle('hidden', v !== 'folder');
  toolbar.el.classList.toggle('hidden', v !== 'avatar');
  if (v !== 'avatar') closePanels();
  canvas.classList.toggle('hidden', v !== 'avatar');
  rerenderUI();
}

function showWelcome() {
  if (app.mateMode) setMateMode(false);
  unloadAvatar();
  setView('welcome');
  welcome.refresh();
}

function showFolder(dir?: string) {
  if (app.mateMode) setMateMode(false);
  unloadAvatar();
  setView('folder');
  folder.open(dir || general.lastFolder);
}

function rerenderUI() {
  toolbar.refresh();
  for (const p of panels.values()) if (!p.el.classList.contains('hidden')) p.refresh();
  info.refresh();
}

function closePanels(except?: string) {
  for (const [id, p] of panels) if (id !== except) p.el.classList.add('hidden');
  if (app.mateMode && !except) syncMateWindowBounds({ restoreOnly: true });
  toolbar.refresh();
}

function togglePanel(id: string) {
  const p = panels.get(id);
  if (!p) return;
  const show = p.el.classList.contains('hidden');
  // The face tracking / lighting / params windows open next to their parents.
  const keep = id === 'face' ? 'streaming' : id === 'lighting' || id === 'layout' ? 'settings' : undefined;
  if (show) {
    for (const [pid, other] of panels) {
      if (pid !== id && pid !== keep && !(id === 'params')) other.el.classList.add('hidden');
    }
    p.el.classList.remove('hidden');
    if (app.mateMode) syncMateWindowBounds();
    p.onShow?.();
    p.refresh();
    positionPanelNearAvatar(p.el);
  } else {
    p.el.classList.add('hidden');
    if (app.mateMode) syncMateWindowBounds({ restoreOnly: true });
  }
  toolbar.refresh();
}

// ---------------------------------------------------------------------------
// Avatar loading

let loadToken = 0;
function setLoading(text: string | null) {
  loading.classList.toggle('hidden', text == null);
  (loading.querySelector('.text') as HTMLElement).textContent = text || '';
}

function unloadAvatar() {
  if (!app.avatar) return;
  // Keep the outgoing avatar's latest values; stopping its animation below must not overwrite them.
  flushAvatarState();
  restoringState = true;
  try {
    unloadAvatarNow();
  } finally {
    restoringState = false;
  }
}

function unloadAvatarNow() {
  if (!app.avatar) return;
  radial.close();
  player.avatarClip = undefined;
  player.setAvatar(null);
  streaming.setAvatar(null);
  app.vrc?.dispose();
  app.vrc = null;
  gestures.vrc = null;
  app.avatar.dispose();
  app.avatar = null;
  vav.watchAvatar(null);
}

async function loadAvatar(path: string, opts: { keepCamera?: boolean } = {}) {
  const lower = path.toLowerCase();
  if (!/\.(vrm|glb|gltf)$/.test(lower)) { toast(t('load.unsupported')); return; }
  const token = ++loadToken;
  setLoading(t('load.loading'));
  const snapshot = opts.keepCamera ? stage.rig.snapshot() : null;
  const rootState = opts.keepCamera
    ? { rot: stage.avatarRoot.rotation.clone(), pos: stage.avatarRoot.position.clone(), scale: stage.avatarRoot.scale.x }
    : null;
  const playing = opts.keepCamera ? player.current : null;
  try {
    const avatar = await Avatar.load(vav.fileUrl(path), path, (r) => setLoading(`${t('load.loading')} ${Math.round(r * 100)}%`));
    const fxMeta = token === loadToken ? await readSidecar(path) : null;
    if (token !== loadToken) { avatar.dispose(); return; }
    // Compile the avatar's shaders (often dozens of MToon variants) in parallel before it appears,
    // instead of stalling the first frames.
    try {
      setLoading(t('load.preparing'));
      await stage.renderer.compileAsync(avatar.scene, stage.rig.camera, stage.scene);
    } catch (err) {
      console.warn('[load] shader precompile', err);
    }
    if (token !== loadToken) { avatar.dispose(); return; }
    unloadAvatar();
    app.avatar = avatar;
    stage.avatarOffset.add(avatar.scene);
    gestures.reset();
    if (fxMeta) {
      app.vrc = createVrcRuntime(avatar, fxMeta);
      app.vrc.onChange = () => { markActive(); rememberAvatarState(); radial.refresh(); };
      if (app.vrc instanceof VrcAnimator) {
        // Parameter drivers / gestures changed menu values: keep an open Expression Menu in sync.
        app.vrc.onParamsChange = () => {
          const p = panels.get('params');
          if (p && !p.el.classList.contains('hidden')) p.refresh();
          radial.refresh();
          rememberAvatarState();
        };
        const fx = app.vrc;
        player.avatarClip = (i) => fx.toAnimationClip(i);
      }
      gestures.vrc = app.vrc;
      if (!opts.keepCamera) toast(t('load.vavmeta'), 2500);
    }
    player.setAvatar(avatar);
    streaming.setAvatar(avatar);
    stage.avatarRoot.rotation.set(0, 0, 0);
    stage.avatarRoot.position.set(0, 0, 0);
    stage.avatarRoot.scale.setScalar(1);
    const box = avatar.restBox.clone();
    stage.standBaseRadius = Math.min(0.6, Math.max(0.25, avatar.height() * 0.21));
    if (app.mateMode && !snapshot) {
      stage.rig.frameForMate(box);
      stage.rig.frameHeight = matePetHeight;
      stage.rig.apply();
    } else {
      stage.rig.frame(box);
      if (snapshot && rootState) {
        stage.rig.restore(snapshot);
        stage.avatarRoot.rotation.copy(rootState.rot);
        stage.avatarRoot.position.copy(rootState.pos);
        stage.avatarRoot.scale.setScalar(rootState.scale);
      } else {
        // The avatar's saved position / scale / rotation and camera view.
        const saved = layoutSettings.byAvatar[layoutKey(path)];
        if (saved && layoutSettings.autoRestore) applyLayout(stage, saved);
      }
    }
    vav.watchAvatar(path);
    rememberRecent(path, avatar);
    applyProfile();
    // The avatar's remembered menu values / motion (also after an automatic reload on re-export).
    const remembered = avatarStates.enabled ? avatarStates.byAvatar[layoutKey(path)] : undefined;
    if (remembered) restoreAvatarState(remembered, !playing);
    setView('avatar');
    if (playing) player.play(playing).catch(() => {});
    if (opts.keepCamera) toast(t('load.reloaded'));
    if (avatar.warnings.length) console.warn(avatar.warnings);
  } catch (err) {
    console.error(err);
    toast(`${t('load.failed')}: ${(err as Error).message || err}`, 6000);
  } finally {
    if (token === loadToken) setLoading(null);
  }
}

/** Reads <name>.vavmeta.json next to the avatar (written by the Unity exporter), if present. */
async function readSidecar(avatarPath: string): Promise<VavMeta | null> {
  const p = sidecarPath(avatarPath);
  try {
    if (!(await vav.fs.exists(p))) return null;
    return parseVavMeta(await vav.fs.readText(p));
  } catch (err) {
    console.error('[vavmeta]', err);
    toast(`${t('load.vavmetaFailed')}: ${(err as Error).message || err}`, 5000);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-avatar memory: avatar menu values, motion, manual expressions

let restoringState = false;
let stateTimer: ReturnType<typeof setTimeout> | undefined;

function rememberAvatarState() {
  if (!avatarStates.enabled || !app.avatar || restoringState) return;
  clearTimeout(stateTimer);
  stateTimer = setTimeout(saveAvatarState, 500);
}

function flushAvatarState() {
  if (stateTimer === undefined) return;
  clearTimeout(stateTimer);
  stateTimer = undefined;
  saveAvatarState();
}
window.addEventListener('beforeunload', () => flushAvatarState());

function saveAvatarState() {
  stateTimer = undefined;
  const a = app.avatar;
  if (!a || !avatarStates.enabled) return;
  const st: AvatarState = { savedAt: new Date().toISOString() };
  if (app.vrc) st.params = app.vrc.savedValues();
  else {
    const manual = paramsPanel.manualState();
    if (manual) st.manual = manual;
  }
  const cur = player.current;
  st.motion = cur ? { path: cur.path, name: cur.name, playing: player.playing } : null;
  avatarStates.byAvatar[layoutKey(a.path)] = st;
  avatarStates.save();
}

function restoreAvatarState(st: AvatarState, withMotion: boolean) {
  const a = app.avatar;
  if (!a) return;
  restoringState = true;
  try {
    if (app.vrc) app.vrc.restore(st.params);
    else if (st.manual) paramsPanel.restoreManual(a, st.manual);
  } finally {
    restoringState = false;
  }
  if (withMotion && st.motion) restoreMotion(st.motion);
}

async function restoreMotion(m: NonNullable<AvatarState['motion']>) {
  let item = { path: m.path, name: m.name };
  if (m.path.startsWith('avatar-clip:')) {
    // Clip numbers change when the avatar is exported again; the name does not.
    const found = app.vrc instanceof VrcAnimator ? app.vrc.animations().find((x) => x.name === m.name) : undefined;
    if (!found) return;
    item = { path: `avatar-clip:${found.clip}`, name: found.name };
  } else if (!(await vav.fs.exists(m.path))) {
    return;
  }
  try {
    await player.play(item);
    if (!m.playing) player.pause();
  } catch (err) {
    console.warn('[avatar state] motion', err);
  }
}

function rememberRecent(path: string, avatar: Avatar) {
  const list = general.recent.filter((r) => r.path !== path);
  list.unshift({ path, title: avatar.info.title });
  general.recent = list.slice(0, 8);
  general.save();
}

async function openAvatarDialog() {
  const p = await vav.dialog.openAvatar();
  if (p) { app.cameFromFolder = false; await loadAvatar(p); }
}

async function openFolderDialog() {
  const dir = await vav.dialog.openFolder(general.lastFolder || undefined);
  if (dir) {
    general.lastFolder = dir;
    general.save();
    showFolder(dir);
  }
}

async function reloadProfiles() {
  const r = await vav.profiles.list();
  app.profiles = r.profiles;
  app.profileErrors = r.errors;
  applyProfile();
}

function applyProfile() {
  streaming.profile = app.profiles.find((p) => p.file === streamSettings.profileFile) || null;
  if (app.avatar && streaming.profile) {
    // Report targets that do not exist on this avatar (shown in the info overlay).
    const missing: string[] = [];
    for (const e of streaming.profile.expressions) {
      if (!app.avatar.resolveShape(e.target, e.renderer).length) missing.push(`${e.source} → ${e.renderer ? e.renderer + '/' : ''}${e.target}`);
    }
    if (missing.length) console.warn('[avatar profile] targets not found:', missing);
    (app as any).profileMissing = missing;
  } else {
    (app as any).profileMissing = [];
  }
}

function faceFront() {
  if (layoutLocked()) return;
  // Keep the position, only turn the avatar so it faces the camera.
  stage.avatarRoot.rotation.y = stage.rig.yaw;
  markActive();
}

// ---------------------------------------------------------------------------
// Position / scale / rotation: save per avatar, lock, reset

let lockNoticeAt = 0;
/** True (with a short reminder) while the layout is locked. */
function layoutLocked() {
  if (!layoutSettings.locked) return false;
  const now = performance.now();
  if (now - lockNoticeAt > 4000) { lockNoticeAt = now; toast(t('layout.lockedNotice'), 2600); }
  return true;
}

function saveLayout() {
  if (!app.avatar) return;
  const l = captureLayout(stage);
  layoutSettings.byAvatar[layoutKey(app.avatar.path)] = l;
  layoutSettings.last = l;
  layoutSettings.save();
  toast(t('layout.saved', { name: app.avatar.info.title }));
}

function restoreLayout(): boolean {
  if (!app.avatar || layoutLocked()) return false;
  const l = layoutSettings.byAvatar[layoutKey(app.avatar.path)] || layoutSettings.last;
  if (!l) { toast(t('layout.noSaved')); return false; }
  applyLayout(stage, l);
  rerenderUI();
  markActive();
  return true;
}

function resetLayoutCmd() {
  if (layoutLocked()) return;
  if (app.mateMode && app.avatar) {
    stage.avatarRoot.position.set(0, 0, 0);
    stage.avatarRoot.rotation.set(0, 0, 0);
    stage.avatarRoot.scale.setScalar(1);
    stage.rig.frameForMate(app.avatar.restBox);
    matePetHeight = Math.min(560, mateMaxHeight);
    stage.rig.frameHeight = matePetHeight;
    syncMateWindowBounds();
    rerenderUI();
    markActive();
    return;
  }
  resetLayout(stage);
  rerenderUI();
  markActive();
}

function setLayoutLocked(v: boolean) {
  layoutSettings.locked = v;
  layoutSettings.save();
  lockNoticeAt = performance.now();
  toast(t(v ? 'layout.lockedOn' : 'layout.lockedOff'));
  rerenderUI();
}

// ---------------------------------------------------------------------------
// Transparent mode, Desktop Mate mode, click-through, avatar see-through

function applyTransparentOptions() {
  if (app.mateMode) {
    vav.win.setMateMode({
      mateMode: true,
      alwaysOnTop: transparentSettings.alwaysOnTop,
      clickThrough: transparentSettings.clickThrough,
    });
    updateCursorWanted();
    return;
  }
  vav.win.setTransparent({
    transparent: app.transparent,
    alwaysOnTop: transparentSettings.alwaysOnTop,
    clickThrough: transparentSettings.clickThrough,
  });
  updateCursorWanted();
}

function setTransparent(on: boolean) {
  if (app.mateMode && !on) {
    setMateMode(false);
    return;
  }
  app.transparent = on;
  stage.setTransparent(on);
  applyTransparentOptions();
  if (!on) {
    ignoring = false;
    canvas.style.opacity = '1';
    vav.win.setIgnoreMouse(false);
  } else {
    hitTest();
    updateClickThrough();
    toast(t('toast.transparentOn', { key: t(`key.${transparentSettings.releaseKey}`) }), 3500);
  }
  rerenderUI();
  markActive();
}

async function setMateMode(on: boolean) {
  if (app.mateMode === on) return;
  if (on) {
    if (!mateFlag.enabled) await setMateEnabled(true);
    radial.close();
    closePanels();
    studioSnapshot = {
      rig: stage.rig.snapshot(),
      rot: stage.avatarRoot.rotation.clone(),
      pos: stage.avatarRoot.position.clone(),
      scale: stage.avatarRoot.scale.x,
      transparent: app.transparent && !app.mateMode,
    };
    const tr = vav.win.setMateMode({
      mateMode: true,
      alwaysOnTop: transparentSettings.alwaysOnTop,
      clickThrough: transparentSettings.clickThrough,
    });
    app.mateMode = true;
    app.transparent = true;
    if (general.lastTransparent !== true) { general.lastTransparent = true; general.save(); }
    mateMaxHeight = tr ? Math.max(360, Math.round(tr.workArea.height * 1.35)) : 1400;
    matePetHeight = tr ? tr.to.height : 560;
    stage.setMateMode(true);
    stage.rig.frameHeight = matePetHeight;
    if (app.avatar) {
      stage.avatarRoot.position.set(0, 0, 0);
      stage.rig.frameForMate(app.avatar.restBox);
    }
    stage.resize();
    stage.rig.apply();
    updateCursorWanted();
    hitTest();
    updateClickThrough();
    if (app.mate) toast(app.mate.controlsHint(), 4500);
  } else {
    clearTimeout(mateResizeTimer);
    mateResizeTimer = undefined;
    radial.close();
    for (const p of panels.values()) p.el.classList.add('hidden');
    vav.win.setMateMode({ mateMode: false });
    app.mateMode = false;
    stage.rig.frameHeight = null;
    stage.rig.offsetX = 0;
    stage.rig.offsetY = 0;
    if (studioSnapshot) {
      stage.rig.restore(studioSnapshot.rig);
      stage.avatarRoot.rotation.copy(studioSnapshot.rot);
      stage.avatarRoot.position.copy(studioSnapshot.pos);
      stage.avatarRoot.scale.setScalar(studioSnapshot.scale);
      app.transparent = studioSnapshot.transparent;
      studioSnapshot = null;
    } else {
      app.transparent = false;
      if (app.avatar) stage.rig.frame(app.avatar.restBox);
    }
    if (general.lastTransparent !== false) { general.lastTransparent = false; general.save(); }
    stage.setMateMode(false);
    stage.setTransparent(app.transparent);
    if (app.transparent) {
      applyTransparentOptions();
    } else {
      ignoring = false;
      canvas.style.opacity = '1';
      vav.win.setIgnoreMouse(false);
      updateCursorWanted();
    }
    stage.resize();
    stage.rig.apply();
    clampPanelsToViewport();
  }
  rerenderUI();
  markActive();
}

function updateCursorWanted() {
  vav.win.wantCursor(general.cursorGaze || app.transparent || app.mateMode);
}
(app as any).updateCursorWanted = updateCursorWanted;

const cursor = { x: -1, y: -1, inside: false, mods: {} as Record<string, boolean>, polled: false };
let hitAvatar = false;
let lastHitTest = 0;
let ignoring = false;

vav.on('cursor', (c: CursorInfo) => {
  const moved = c.x !== cursor.x || c.y !== cursor.y;
  cursor.polled = true;
  cursor.x = c.x;
  cursor.y = c.y;
  cursor.inside = c.x >= 0 && c.y >= 0 && c.x < c.width && c.y < c.height;
  cursor.mods = c.modifiers || {};
  if ((app.transparent || app.mateMode) && moved && performance.now() - lastHitTest > 40) {
    tick();
  } else {
    updateClickThrough();
  }
});

function modHeld(key: ModKey) {
  return !!cursor.mods[key];
}

function overUI(x: number, y: number) {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  return !!el && el !== canvas && el !== document.body && !el.closest('#loading') && !!el.closest('#ui > *:not(.hidden), #drag-bar');
}

function nearAvatar(x: number, y: number) {
  const ax = window.innerWidth * 0.5 + stage.rig.offsetX;
  const ay = window.innerHeight * 0.5 + stage.rig.offsetY;
  const halfW = app.mateMode ? Math.round(matePetHeight * MATE_ASPECT * 0.5) : window.innerWidth * 0.45;
  const halfH = app.mateMode ? Math.round(matePetHeight * 0.5) : window.innerHeight * 0.48;
  return Math.abs(x - ax) <= halfW && Math.abs(y - ay) <= halfH;
}

function updateClickThrough() {
  if (!app.transparent && !app.mateMode) return;
  const release = modHeld(transparentSettings.releaseKey);
  // The bottom toolbar is hidden with a transparent background (right-click the avatar for the menu).
  toolbar.setHover(false);
  const activeInteraction = !!(windowMove || drag || radial.isOpen());
  const interactive = activeInteraction || (cursor.inside && (
    release ||
    hitAvatar ||
    overUI(cursor.x, cursor.y) ||
    (!transparentSettings.clickThrough && nearAvatar(cursor.x, cursor.y))
  ));
  const ignore = !interactive;
  if (ignore !== ignoring) {
    ignoring = ignore;
    vav.win.setIgnoreMouse(ignore);
  }
  // Avatar see-through mode: fade while hovering the avatar unless the key is held.
  if (transparentSettings.avatarFade && app.avatar) {
    const fade = hitAvatar && cursor.inside && !modHeld(transparentSettings.fadeKey);
    canvas.style.opacity = fade ? String(transparentSettings.fadeOpacity) : '1';
  } else {
    canvas.style.opacity = '1';
  }
}

const HIT_RADIUS = 3;
const HIT_SIDE = HIT_RADIUS * 2 + 1;
const pixelPatch = new Uint8Array(HIT_SIDE * HIT_SIDE * 4);
function hitTest() {
  if ((!app.transparent && !app.mateMode) || !cursor.inside) { hitAvatar = false; return; }
  const gl = stage.renderer.getContext();
  const dpr = stage.renderer.getPixelRatio();
  const cx = Math.floor(cursor.x * dpr);
  const cy = Math.floor((window.innerHeight - cursor.y) * dpr);
  const maxW = gl.drawingBufferWidth;
  const maxH = gl.drawingBufferHeight;
  const x0 = Math.max(0, Math.min(maxW - HIT_SIDE, cx - HIT_RADIUS));
  const y0 = Math.max(0, Math.min(maxH - HIT_SIDE, cy - HIT_RADIUS));
  const w = Math.min(HIT_SIDE, maxW - x0);
  const h = Math.min(HIT_SIDE, maxH - y0);
  if (w <= 0 || h <= 0) { hitAvatar = false; return; }
  gl.readPixels(x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixelPatch);
  let hit = false;
  const count = w * h * 4;
  for (let i = 3; i < count; i += 4) {
    if (pixelPatch[i] > 20) { hit = true; break; }
  }
  hitAvatar = hit;
}

// ---------------------------------------------------------------------------
// Camera / avatar mouse + keyboard controls

// A right click (no drag) opens the radial menu; dragging rotates / moves as before. With the layout
// locked the menu still opens and only an actual drag shows the lock reminder.
// Desktop character controls (its switch on, by default with a transparent background): a left click makes the
// avatar react, a left drag moves the avatar (or Option/Alt + left drag rotates), scrolling over the avatar zooms at the pointer.
let drag: {
  button: number; x: number; y: number; sx: number; sy: number; moved: boolean; locked: boolean;
  /** desktop character controls: screen position for moving the avatar / window */
  mate: boolean; scrX: number; scrY: number;
} | null = null;

function mateControls() {
  return app.mateMode || !!app.mate?.controls(app.transparent);
}

canvas.addEventListener('pointerdown', (e) => {
  if (app.view !== 'avatar') return;
  if (windowMove) { beginWindowDrag(e, canvas); return; }
  if (radial.isOpen() && e.button !== 2) { radial.close(); return; }
  drag = {
    button: e.button, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false, locked: layoutSettings.locked,
    mate: mateControls(), scrX: e.screenX, scrY: e.screenY,
  };
  try { canvas.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
  markActive();
});
canvas.addEventListener('pointermove', (e) => {
  if (!cursor.polled) { cursor.x = e.clientX; cursor.y = e.clientY; cursor.inside = true; }
  if (!drag) return;
  if (!drag.moved) {
    if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 4) return;
    drag.moved = true;
    if (drag.locked) layoutLocked();
  }
  if (drag.locked) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  drag.x = e.clientX;
  drag.y = e.clientY;
  const sdx = e.screenX - drag.scrX;
  const sdy = e.screenY - drag.scrY;
  drag.scrX = e.screenX;
  drag.scrY = e.screenY;
  if (drag.button === 0 && drag.mate && !e.altKey) {
    if (sdx || sdy) vav.win.moveBy(sdx, sdy);
    markActive();
    return;
  }
  if (drag.button === 0) {
    stage.avatarRoot.rotation.y += dx * 0.01;
    stage.rig.pitch = THREE.MathUtils.clamp(stage.rig.pitch + dy * 0.005, -1.2, 1.35);
  } else if (drag.button === 2 || drag.button === 1) {
    if (app.mateMode) {
      if (sdx || sdy) vav.win.moveBy(sdx, sdy);
    } else {
      const k = stage.rig.worldPerPixel(window.innerHeight);
      const cam = stage.rig.camera;
      const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
      stage.avatarRoot.position.addScaledVector(right, dx * k).addScaledVector(up, -dy * k);
    }
  }
  markActive();
});
canvas.addEventListener('pointerup', (e) => {
  const d = drag;
  drag = null;
  if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  if (d && d.button === 2 && !d.moved && app.avatar) radial.open(e.clientX, e.clientY);
  if (d && d.button === 0 && !d.moved && (d.mate || (app.mate && mateFlag.enabled)) && app.avatar) {
    app.mate?.poke(e.clientX, e.clientY, (app.transparent || app.mateMode) ? hitAvatar : true);
  }
  updateClickThrough();
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (app.view !== 'avatar') return;
  const mateZoom = mateControls();
  // In transparent click-through mode, only zoom while hovering the avatar (unless the release key is held).
  if ((app.transparent || app.mateMode) && transparentSettings.clickThrough && !modHeld(transparentSettings.releaseKey) && !hitAvatar) return;
  if (layoutLocked()) return;
  const factor = Math.exp(e.deltaY * 0.0012);
  if (mateZoom) zoomAt(e.clientX, e.clientY, factor);
  else stage.rig.distance = THREE.MathUtils.clamp(stage.rig.distance * factor, 0.15, 30);
  markActive();
}, { passive: false });
// A double click resets the view, but not with the desktop character controls (clicks there are pokes).
canvas.addEventListener('dblclick', () => { if (!mateControls() && !(app.mate && mateFlag.enabled)) resetView(); });

/** Zooms keeping the point under the pointer where it is. */
const zoomRay = new THREE.Raycaster();
const zoomPlane = new THREE.Plane();
function pointOnTargetPlane(x: number, y: number) {
  const cam = stage.rig.camera;
  zoomRay.setFromCamera(new THREE.Vector2((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1), cam);
  zoomPlane.setFromNormalAndCoplanarPoint(cam.getWorldDirection(new THREE.Vector3()).negate(), stage.rig.target);
  return zoomRay.ray.intersectPlane(zoomPlane, new THREE.Vector3());
}
function zoomAt(x: number, y: number, factor: number) {
  if (app.mateMode) {
    const ax = THREE.MathUtils.clamp(x / Math.max(1, window.innerWidth), 0.15, 0.85);
    const ay = THREE.MathUtils.clamp(y / Math.max(1, window.innerHeight), 0.15, 0.9);
    matePetHeight = THREE.MathUtils.clamp(matePetHeight / factor, 220, mateMaxHeight);
    stage.rig.frameHeight = matePetHeight;
    stage.rig.applyProjectionOffset();
    const petW = Math.round(matePetHeight * MATE_ASPECT);
    if (matePetHeight > window.innerHeight - 6 || petW > window.innerWidth - 6 || Math.abs(matePetHeight - window.innerHeight) > 72) {
      syncMateWindowBounds({ anchorX: ax, anchorY: ay });
    } else {
      clearTimeout(mateResizeTimer);
      mateResizeTimer = setTimeout(() => syncMateWindowBounds({ anchorX: ax, anchorY: ay }), 140);
    }
    return;
  }
  const rig = stage.rig;
  rig.apply();
  const before = pointOnTargetPlane(x, y);
  rig.distance = THREE.MathUtils.clamp(rig.distance * factor, 0.15, 30);
  rig.apply();
  const after = pointOnTargetPlane(x, y);
  if (before && after) { rig.target.add(before.sub(after)); rig.apply(); }
}

function resetView() {
  resetLayoutCmd();
}
(app as any).resetView = resetView;

const shiftState = { left: false, right: false };
window.addEventListener('keydown', (e) => {
  if (e.code === 'ShiftLeft') shiftState.left = true;
  if (e.code === 'ShiftRight') shiftState.right = true;
  const target = e.target as HTMLElement;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return;
  if (app.view !== 'avatar') return;
  const fk = /^F([1-8])$/.exec(e.code);
  if (fk && e.shiftKey) {
    const side = shiftState.right && !shiftState.left ? 'right' : 'left';
    gestures.set(side, parseInt(fk[1], 10) - 1);
    e.preventDefault();
    markActive();
    return;
  }
  const step = 0.06;
  const moves = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', '_'];
  if (moves.includes(e.key) && layoutLocked()) { e.preventDefault(); return; }
  switch (e.key) {
    case 'ArrowLeft':
    case 'ArrowRight':
    case 'ArrowUp':
    case 'ArrowDown': {
      const dir = e.key === 'ArrowLeft' ? [-1, 0] : e.key === 'ArrowRight' ? [1, 0] : e.key === 'ArrowUp' ? [0, 1] : [0, -1];
      if (e.ctrlKey || e.metaKey) {
        const cam = stage.rig.camera;
        const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
        const k = stage.rig.distance * 0.04;
        stage.rig.target.addScaledVector(right, dir[0] * k).addScaledVector(up, dir[1] * k);
      } else {
        stage.rig.yaw += dir[0] * step;
        stage.rig.pitch = THREE.MathUtils.clamp(stage.rig.pitch + dir[1] * step, -1.2, 1.35);
      }
      e.preventDefault();
      break;
    }
    case '+':
    case '=':
      stage.rig.distance = Math.max(0.15, stage.rig.distance * 0.92);
      break;
    case '-':
    case '_':
      stage.rig.distance = Math.min(30, stage.rig.distance * 1.08);
      break;
    case 'i':
    case 'I':
      if (!e.metaKey && !e.ctrlKey) { general.infoOverlay = !general.infoOverlay; general.save(); info.refresh(); }
      break;
    case 'Escape':
      if (windowMove) endWindowMove();
      else if (radial.isOpen()) radial.close();
      else closePanels();
      break;
    default:
      return;
  }
  markActive();
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'ShiftLeft') shiftState.left = false;
  if (e.code === 'ShiftRight') shiftState.right = false;
});
window.addEventListener('blur', () => { shiftState.left = false; shiftState.right = false; });

vav.on('gesture-key', (ev: { side: 'left' | 'right'; index: number }) => {
  if (!general.alwaysKeys || app.view !== 'avatar') return;
  gestures.set(ev.side, ev.index);
  markActive();
});
gestures.onChange = (side, index) => {
  toast(`${t(side === 'left' ? 'gesture.left' : 'gesture.right')}: ${t(`gesture.${index}`)}`, 1200);
  rerenderUI();
};
streaming.onGesture = (side, value) => {
  if (value >= 0 && value <= 7) gestures.set(side, value, false);
};

// ---------------------------------------------------------------------------
// Drag & drop

window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
window.addEventListener('dragleave', () => document.body.classList.remove('dragging'));
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  const files = Array.from(e.dataTransfer?.files || []);
  const paths = files.map((f) => vav.pathForFile(f)).filter(Boolean);
  const avatarPath = paths.find((p) => /\.(vrm|glb|gltf)$/i.test(p));
  const anims = paths.filter(isAnimationPath);
  if (avatarPath) {
    app.cameFromFolder = false;
    await loadAvatar(avatarPath);
  }
  if (anims.length) {
    if (!app.avatar) { toast(t('anim.needAvatar')); return; }
    (panels.get('animation') as any).addFiles(anims.map(animItemFromPath));
  }
});

vav.on('menu:open-avatar', () => openAvatarDialog());
vav.on('menu:open-path', (p: string) => { app.cameFromFolder = false; loadAvatar(p); });
vav.on('avatar:changed', (p: string) => {
  if (app.avatar && app.avatar.path === p) loadAvatar(p, { keepCamera: true });
});
vav.on('syphon:exited', () => {
  if (syphon.running) { syphon.stop(); toast(t('st.syphon.unavailable')); }
});
let minimized = false;
vav.on('win:minimized', (m: boolean) => { minimized = m; markActive(); });
// Clicking another app (e.g. through the transparent background) closes the radial menu.
vav.on('win:focus', (focused: boolean) => { if (!focused) radial.close(); });

window.addEventListener('resize', () => {
  stage.resize();
  clampPanelsToViewport();
  markActive();
});

// ---------------------------------------------------------------------------
// Cursor gaze

const lookTarget = new THREE.Object3D();
stage.scene.add(lookTarget);
const headTurn = new THREE.Quaternion();
const raycaster = new THREE.Raycaster();
const tmpV = new THREE.Vector3();
const plane = new THREE.Plane();

function updateGaze(dt: number) {
  const a = app.avatar;
  if (!a) return;
  const la = a.vrm?.lookAt;
  if (streaming.drivesGaze) return;
  const head = a.humanoid?.getNormalizedBoneNode('head');
  if (!general.cursorGaze || !head) {
    if (la && (Math.abs(la.yaw) > 0.01 || Math.abs(la.pitch) > 0.01 || la.target)) { la.target = null; la.yaw *= 0.85; la.pitch *= 0.85; }
    if (head && headTurn.w < 0.99999) {
      headTurn.slerp(new THREE.Quaternion(), 1 - Math.exp(-dt * 6));
      if (!streaming.headTracked && !player.active) head.quaternion.copy(headTurn);
    }
    return;
  }
  head.getWorldPosition(tmpV);
  const cam = stage.rig.camera;
  const ndc = new THREE.Vector2((cursor.x / window.innerWidth) * 2 - 1, -(cursor.y / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, cam);
  const camDir = cam.getWorldDirection(new THREE.Vector3());
  plane.setFromNormalAndCoplanarPoint(camDir.clone().negate(), tmpV.clone().addScaledVector(camDir, -0.6));
  const hit = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
  if (hit) lookTarget.position.copy(hit);
  if (la) la.target = lookTarget;
  // Turn the head a little toward the cursor (unless tracking drives it).
  if (!streaming.headTracked && !player.active) {
    const local = stage.avatarRoot.worldToLocal(lookTarget.position.clone()).sub(stage.avatarRoot.worldToLocal(tmpV.clone()));
    const yaw = THREE.MathUtils.clamp(Math.atan2(local.x, local.z), -0.6, 0.6) * 0.45;
    const pitch = THREE.MathUtils.clamp(-Math.atan2(local.y, Math.hypot(local.x, local.z)), -0.5, 0.5) * 0.4;
    const target = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
    if (a.metaVersion === '0') target.set(-target.x, target.y, -target.z, target.w);
    headTurn.slerp(target, 1 - Math.exp(-dt * 6));
  } else {
    headTurn.slerp(new THREE.Quaternion(), 1 - Math.exp(-dt * 6));
  }
  if (!streaming.headTracked && !player.active) head.quaternion.copy(headTurn);
}

// ---------------------------------------------------------------------------
// Render loop with "lower FPS when idle"

let lastActive = performance.now();
function markActive() { lastActive = performance.now(); }
let last = performance.now();
let lastRender = 0;
let layoutSyncAt = 0;
let frameCount = 0;
let fpsTime = performance.now();
const center = new THREE.Vector3();

function isActive(now: number) {
  if (general.lowFps === 'off') return true;
  if (now - lastActive < 1200) return true;
  if (drag) return true;
  if (player.playing) return true;
  if (streaming.vmcActive() || streaming.oscActive()) return true;
  if (gestures.isActive() && now - lastActive < 2000) return true;
  if (app.avatar && app.avatar.springMotion() > 0.00015) return true;
  if (general.lowFps === 'shader' && app.avatar?.hasAnimatedShader) return true;
  if (app.vrc instanceof VrcAnimator && app.vrc.busy) return true;
  if (app.autocast?.busy()) return true;
  return false;
}

function tick() {
  const now = performance.now();
  let interval = 0;
  if (minimized || document.hidden) interval = 1000;
  // The desktop character motion keeps going at 30 fps when nothing else needs the full rate.
  else if (!isActive(now)) interval = app.mate?.busy() ? 33 : 200;
  if (now - lastRender < interval - 1) return;
  lastRender = now;
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  const a = app.avatar;
  if (a && app.view === 'avatar') {
    app.mate?.beginFrame();
    player.update(dt);
    streaming.update(dt);
    gestures.update(a, dt, streaming.fingersTracked);
    updateGaze(dt);
    // VRChat avatar animator (sidecar v2): FX toggles, Action layer dances / AFK, Gesture-layer hands.
    if (app.vrc instanceof VrcAnimator) app.vrc.update(dt, { fingersTracked: streaming.fingersTracked });
    app.autocast?.update(dt);
    app.mate?.update(dt);
    stage.avatarOffset.position.y = player.active ? animSettings.yOffset : 0;
    a.update(dt);
    const foot = a.footY(stage.avatarRoot);
    const footY = foot != null ? foot - a.soleOffset : a.restBox.min.y + stage.avatarOffset.position.y;
    stage.updateStand(footY, animSettings.standSize);
    center.set(0, a.height() * 0.55, 0);
    stage.avatarRoot.localToWorld(center);
    stage.updateLight(center, a.height());
  }
  const emphasis = streamSettings.zoomEmphasis * (streaming.vmcActive() ? streaming.zoomSignal : 0);
  stage.rig.zoomFactor += ((1 - emphasis * 0.45) - stage.rig.zoomFactor) * Math.min(1, dt * 8);
  stage.rig.apply();
  if (now - layoutSyncAt > 100 && !layoutPanel.el.classList.contains('hidden')) { layoutSyncAt = now; layoutPanel.sync(); }
  stage.render();
  if ((app.transparent || app.mateMode) && now - lastHitTest > 50) {
    lastHitTest = now;
    hitTest();
    updateClickThrough();
  }
  if (app.view === 'avatar') syphon.capture(stage, now);

  frameCount++;
  if (now - fpsTime > 500) {
    app.fps = (frameCount * 1000) / (now - fpsTime);
    frameCount = 0;
    fpsTime = now;
    info.refresh();
  }
}

function frame() {
  tick();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
// rAF stops while minimized/hidden; keep a slow tick so Syphon/VMC keep going.
setInterval(() => { if (document.hidden || minimized) tick(); }, 1000);

// ---------------------------------------------------------------------------
// Startup

(async () => {
  vav.setLanguage(general.language);
  app.sysInfo = await vav.sysInfo();
  await reloadProfiles();
  updateCursorWanted();
  if (general.alwaysKeys) {
    const r = await vav.keys.setGlobal(true);
    if (!r.ok) { general.alwaysKeys = false; general.save(); }
  }
  if (general.openLast && (await openLastState())) return;
  if (general.lastFolder && (await vav.fs.exists(general.lastFolder))) showFolder(general.lastFolder);
  else showWelcome();
})();

/** "Start with the last state": the last avatar, in Desktop Mate mode if it was on. */
async function openLastState(): Promise<boolean> {
  const last = general.recent[0]?.path;
  if (!last || !(await vav.fs.exists(last))) return false;
  app.cameFromFolder = false;
  await loadAvatar(last);
  if (!app.avatar) return false;
  if (general.lastTransparent) {
    await setMateMode(true);
  }
  return true;
}
