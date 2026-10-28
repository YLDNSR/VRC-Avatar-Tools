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
import type { App } from './app';
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
  transparent: false, view: 'welcome', cameFromFolder: false,
  loadAvatar, openAvatarDialog, openFolderDialog, rememberAvatarState, startWindowMove, saveLayout, restoreLayout, resetLayout: resetLayoutCmd, setLayoutLocked,
  showWelcome, showFolder, setTransparent, applyTransparentOptions,
  markActive, rerenderUI, closePanels, togglePanel, reloadProfiles, applyProfile, faceFront,
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

// Window move (radial menu → 창 이동): drag the grip or the avatar; releasing ends it. With a transparent
// background the bottom toolbar and its move handle are hidden, so this is how the window moves.
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
  unloadAvatar();
  setView('welcome');
  welcome.refresh();
}

function showFolder(dir?: string) {
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
    p.onShow?.();
    p.refresh();
  } else {
    p.el.classList.add('hidden');
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
// Transparent mode, click-through, avatar see-through

function applyTransparentOptions() {
  vav.win.setTransparent({
    transparent: app.transparent,
    alwaysOnTop: transparentSettings.alwaysOnTop,
    clickThrough: transparentSettings.clickThrough,
  });
  updateCursorWanted();
}

function setTransparent(on: boolean) {
  app.transparent = on;
  if (general.lastTransparent !== on) { general.lastTransparent = on; general.save(); }
  stage.setTransparent(on);
  applyTransparentOptions();
  if (!on) { canvas.style.opacity = '1'; vav.win.setIgnoreMouse(false); }
  else toast(t('toast.transparentOn', { key: t(`key.${transparentSettings.releaseKey}`) }), 3500);
  rerenderUI();
  markActive();
}

function updateCursorWanted() {
  vav.win.wantCursor(general.cursorGaze || (app.transparent && (transparentSettings.clickThrough || transparentSettings.avatarFade)));
}
(app as any).updateCursorWanted = updateCursorWanted;

const cursor = { x: -1, y: -1, inside: false, mods: {} as Record<string, boolean>, polled: false };
let hitAvatar = false;
let lastHitTest = 0;
let ignoring = false;

vav.on('cursor', (c: CursorInfo) => {
  cursor.polled = true;
  cursor.x = c.x;
  cursor.y = c.y;
  cursor.inside = c.x >= 0 && c.y >= 0 && c.x < c.width && c.y < c.height;
  cursor.mods = c.modifiers || {};
  updateClickThrough();
});

function modHeld(key: ModKey) {
  return !!cursor.mods[key];
}

function overUI(x: number, y: number) {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  return !!el && el !== canvas && el !== document.body && !el.closest('#loading') && !!el.closest('#ui > *:not(.hidden), #drag-bar');
}

function updateClickThrough() {
  if (!app.transparent) return;
  const release = modHeld(transparentSettings.releaseKey);
  // The bottom toolbar is hidden with a transparent background (right-click the avatar for the menu).
  toolbar.setHover(false);
  let ignore = false;
  if (transparentSettings.clickThrough && cursor.inside) {
    ignore = !(release || hitAvatar || overUI(cursor.x, cursor.y) || windowMove);
  }
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

const pixel = new Uint8Array(4);
function hitTest() {
  if (!app.transparent || !cursor.inside) { hitAvatar = false; return; }
  const gl = stage.renderer.getContext();
  const dpr = stage.renderer.getPixelRatio();
  const x = Math.floor(cursor.x * dpr);
  const y = Math.floor((window.innerHeight - cursor.y) * dpr);
  gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  hitAvatar = pixel[3] > 20;
}

// ---------------------------------------------------------------------------
// Camera / avatar mouse + keyboard controls

// A right click (no drag) opens the radial menu; dragging rotates / moves as before. With the layout
// locked the menu still opens and only an actual drag shows the lock reminder.
let drag: { button: number; x: number; y: number; sx: number; sy: number; moved: boolean; locked: boolean } | null = null;
canvas.addEventListener('pointerdown', (e) => {
  if (app.view !== 'avatar') return;
  if (windowMove) { beginWindowDrag(e, canvas); return; }
  if (radial.isOpen() && e.button !== 2) { radial.close(); return; }
  drag = { button: e.button, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false, locked: layoutSettings.locked };
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
  if (drag.button === 0) {
    stage.avatarRoot.rotation.y += dx * 0.01;
    stage.rig.pitch = THREE.MathUtils.clamp(stage.rig.pitch + dy * 0.005, -1.2, 1.35);
  } else if (drag.button === 2 || drag.button === 1) {
    const k = stage.rig.worldPerPixel(window.innerHeight);
    const cam = stage.rig.camera;
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    stage.avatarRoot.position.addScaledVector(right, dx * k).addScaledVector(up, -dy * k);
  }
  markActive();
});
canvas.addEventListener('pointerup', (e) => {
  const d = drag;
  drag = null;
  if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  if (d && d.button === 2 && !d.moved && app.avatar) radial.open(e.clientX, e.clientY);
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (app.view !== 'avatar' || layoutLocked()) return;
  stage.rig.distance = THREE.MathUtils.clamp(stage.rig.distance * Math.exp(e.deltaY * 0.0012), 0.15, 30);
  markActive();
}, { passive: false });
canvas.addEventListener('dblclick', () => resetView());

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

window.addEventListener('resize', () => { stage.resize(); markActive(); });

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
  return false;
}

function tick() {
  const now = performance.now();
  let interval = 0;
  if (minimized || document.hidden) interval = 1000;
  else if (!isActive(now)) interval = 200;
  if (now - lastRender < interval - 1) return;
  lastRender = now;
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  const a = app.avatar;
  if (a && app.view === 'avatar') {
    player.update(dt);
    streaming.update(dt);
    gestures.update(a, dt, streaming.fingersTracked);
    updateGaze(dt);
    // VRChat avatar animator (sidecar v2): FX toggles, Action layer dances / AFK, Gesture-layer hands.
    if (app.vrc instanceof VrcAnimator) app.vrc.update(dt, { fingersTracked: streaming.fingersTracked });
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
  if (app.transparent && now - lastHitTest > 50) {
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

/** "Start with the last state": the last avatar, in transparent mode if it was on. */
async function openLastState(): Promise<boolean> {
  const last = general.recent[0]?.path;
  if (!last || !(await vav.fs.exists(last))) return false;
  app.cameFromFolder = false;
  await loadAvatar(last);
  if (!app.avatar) return false;
  if (general.lastTransparent) setTransparent(true);
  return true;
}
