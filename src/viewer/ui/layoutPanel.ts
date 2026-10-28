// Position / scale / rotation panel: the avatar's placement and the camera view as numbers,
// saved per avatar, lockable against mouse / keyboard changes, and resettable.
import * as THREE from 'three';
import type { App } from '../app';
import { h, slider, toggle } from '../../shared/dom';
import { t } from '../../shared/i18n';
import { layoutSettings, layoutKey, clampScale } from '../layout';
import { streaming } from '../settings';
import { panelShell, section, button } from './common';

type SliderCtl = ReturnType<typeof slider>;

/** Angle in degrees wrapped to (-180, 180]. */
function wrapDeg(v: number) {
  const w = ((((v + 180) % 360) + 360) % 360) - 180;
  return w === -180 ? 180 : w;
}

export function createLayoutPanel(app: App) {
  const shell = panelShell(t('set.layout'), () => app.togglePanel('layout'), 'layout-panel');
  const stage = app.stage;
  const root = stage.avatarRoot;
  const rig = stage.rig;
  const deg = THREE.MathUtils.radToDeg;
  const rad = THREE.MathUtils.degToRad;
  const m = (v: number) => `${v.toFixed(2)} m`;
  const d = (v: number) => `${v.toFixed(0)}°`;

  const locked = () => layoutSettings.locked;
  const changed = () => app.markActive();
  // Each row: how to read the live value, how to write it, and its default.
  const rows: { ctl: SliderCtl; get: () => number; last: number }[] = [];
  function row(label: string, min: number, max: number, step: number, fmt: (v: number) => string,
    get: () => number, set: (v: number) => void, def: () => number) {
    const entry = { ctl: null as unknown as SliderCtl, get, last: NaN };
    entry.ctl = slider({
      label, min, max, step, value: get(), format: fmt,
      // While locked the value snaps back to the real one.
      onInput: (v) => { if (locked()) { entry.ctl.set(get()); return; } set(v); changed(); },
      onReset: () => { if (!locked()) { set(def()); changed(); } return get(); },
    });
    rows.push(entry);
    return entry.ctl.el;
  }

  const lock = toggle(t('layout.lock'), layoutSettings.locked, (v) => app.setLayoutLocked(v), t('layout.lockHint'));
  const auto = toggle(t('layout.autoRestore'), layoutSettings.autoRestore, (v) => { layoutSettings.autoRestore = v; layoutSettings.save(); });
  const savedInfo = h('div', { class: 'muted small layout-saved' });

  const avatarRows = [
    row(t('layout.x'), -3, 3, 0.005, m, () => root.position.x, (v) => { root.position.x = v; }, () => 0),
    row(t('layout.y'), -3, 3, 0.005, m, () => root.position.y, (v) => { root.position.y = v; }, () => 0),
    row(t('layout.z'), -3, 3, 0.005, m, () => root.position.z, (v) => { root.position.z = v; }, () => 0),
    row(t('layout.rotY'), -180, 180, 1, d, () => wrapDeg(deg(root.rotation.y)), (v) => { root.rotation.y = rad(v); }, () => 0),
    row(t('layout.rotX'), -90, 90, 1, d, () => wrapDeg(deg(root.rotation.x)), (v) => { root.rotation.x = rad(v); }, () => 0),
    row(t('layout.rotZ'), -90, 90, 1, d, () => wrapDeg(deg(root.rotation.z)), (v) => { root.rotation.z = rad(v); }, () => 0),
    row(t('layout.scale'), 0.1, 3, 0.01, (v) => `${v.toFixed(2)}×`, () => root.scale.x, (v) => { root.scale.setScalar(clampScale(v)); }, () => 1),
  ];
  const cameraRows = [
    row(t('layout.distance'), 0.15, 10, 0.01, m, () => rig.distance, (v) => { rig.distance = v; }, () => rig.home.distance),
    row(t('layout.pitch'), -69, 77, 1, d, () => deg(rig.pitch), (v) => { rig.pitch = rad(v); }, () => deg(rig.home.pitch)),
    row(t('layout.yaw'), -180, 180, 1, d, () => wrapDeg(deg(rig.yaw)), (v) => { rig.yaw = rad(v); }, () => 0),
    row(t('layout.targetY'), -1, 3, 0.005, m, () => rig.target.y, (v) => { rig.target.y = v; }, () => rig.home.target.y),
    row(t('layout.fov'), 10, 90, 1, d, () => rig.camera.fov,
      (v) => { rig.setFov(v); streaming.fov = v; streaming.save(); }, () => 30),
  ];

  const saveBtn = button(t('layout.save'), () => { app.saveLayout(); refresh(); }, 'small');
  const restoreBtn = button(t('layout.restore'), () => { app.restoreLayout(); refresh(); }, 'small');
  const resetBtn = button(t('layout.reset'), () => { app.resetLayout(); refresh(); }, 'small ghost');

  shell.body.append(
    lock.el,
    section(t('layout.avatar'), ...avatarRows),
    section(t('layout.camera'), ...cameraRows),
    section('', h('div', { class: 'button-row' }, saveBtn, restoreBtn, resetBtn), savedInfo, auto.el),
  );

  /** Live values (mouse drags, animation of the camera) without rebuilding the panel. */
  function sync() {
    for (const r of rows) {
      const v = r.get();
      if (Math.abs(v - r.last) < 1e-4) continue;
      r.last = v;
      r.ctl.set(v);
    }
  }

  function refresh() {
    lock.set(layoutSettings.locked);
    auto.set(layoutSettings.autoRestore);
    for (const r of rows) { r.ctl.setDisabled(locked()); r.last = NaN; }
    restoreBtn.disabled = locked();
    resetBtn.disabled = locked();
    shell.el.classList.toggle('is-locked', locked());
    const a = app.avatar;
    const own = a ? layoutSettings.byAvatar[layoutKey(a.path)] : null;
    const saved = own || layoutSettings.last;
    const when = saved ? new Date(saved.savedAt).toLocaleString() : '';
    savedInfo.textContent = own ? t('layout.savedAt', { date: when })
      : saved ? t('layout.savedOther', { date: when }) : t('layout.noSaved');
    sync();
  }

  refresh();
  return { el: shell.el, refresh, sync };
}
