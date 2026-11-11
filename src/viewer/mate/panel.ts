// Controls of the desktop character motion: a section in the Animation panel and the radial menu's ring.
import type { App } from '../app';
import { h, slider, segmented, toggle, toast } from '../../shared/dom';
import { section, button } from '../ui/common';
import { VrcAnimator } from '../vrcAnimator';
import { mateFlag } from './flag';
import { mate, type ActionRate, type ControlMode } from './settings';
import { GESTURES, IDLE_ACTIONS, actionInfo, type ActionName } from './actions';
import type { LifeMotion, Stance } from './life';
import { tm } from './strings';

/** Plays an action from a button (tells when an animation keeps the arms). */
export function playAction(app: App, life: LifeMotion, name: ActionName) {
  if (!app.avatar) { toast(tm('needAvatar')); return; }
  const arms = actionInfo(name).arms;
  const vrc = app.vrc instanceof VrcAnimator ? app.vrc : null;
  if (arms && (app.player.active || vrc?.posesBone('rightUpperArm'))) toast(tm('armsBusy'), 3000);
  life.actions.play(name);
  app.markActive();
}

/** Buttons that play actions now. */
export function actionButtons(app: App, life: LifeMotion, names: readonly ActionName[]) {
  return h('div', { class: 'cast-gestures' }, names.map((n) => button(tm(`action.${n}`), () => playAction(app, life, n), 'small')));
}

export function createMateSection(app: App, life: LifeMotion) {
  const enabled = toggle(tm('enabled'), mateFlag.enabled, async (v) => {
    enabled.setDisabled(true);
    await app.setMateEnabled(v);
    enabled.setDisabled(false);
    enabled.set(mateFlag.enabled);
  }, tm('enabledHint'));
  const rate = segmented<ActionRate>(
    (['off', 'rare', 'normal', 'often'] as const).map((v) => ({ value: v, label: tm(`rate.${v}`) })),
    mate.actions, (v) => { mate.actions = v; mate.save(); });
  const intensity = slider({
    label: tm('intensity'), min: 0.4, max: 1.6, step: 0.05, value: mate.intensity, format: (v) => `${Math.round(v * 100)}%`,
    onInput: (v) => { mate.intensity = v; mate.save(); },
    onReset: () => { mate.intensity = 1; mate.save(); return 1; },
  });
  const stance = segmented<Stance>(
    (['side', 'front', 'back'] as const).map((v) => ({ value: v, label: tm(`stance.${v}`) })),
    life.currentStance, (v) => { life.setStance(v); app.markActive(); });
  const controls = segmented<ControlMode>(
    (['transparent', 'always', 'off'] as const).map((v) => ({ value: v, label: tm(`controls.${v}`) })),
    mate.controls, (v) => { mate.controls = v; mate.save(); });
  const flag = (key: 'fullBody' | 'restPose' | 'poses' | 'breathing' | 'weightShift' | 'lookAround' | 'smallMoves' | 'lookAtViewer' | 'blink') =>
    toggle(tm(key), mate[key] !== false, (v) => { mate[key] = v; mate.save(); app.markActive(); });
  const details = h('details', { class: 'mate-details' },
    h('summary', {}, tm('details')),
    ...(['fullBody', 'restPose', 'poses', 'breathing', 'weightShift', 'lookAround', 'smallMoves', 'lookAtViewer', 'blink'] as const).map((k) => flag(k).el));

  const el = section(tm('title'),
    enabled.el,
    h('div', { class: 'row mate-row' }, h('span', { class: 'label' }, tm('rate')), rate.el),
    intensity.el,
    h('div', { class: 'row mate-row' }, h('span', { class: 'label' }, tm('stance')), stance.el),
    h('div', { class: 'row mate-row' }, h('span', { class: 'label' }, tm('controls')), controls.el),
    h('div', { class: 'muted small' }, tm('controlsHint')),
    details,
    h('div', { class: 'section-subtitle' }, tm('actions')),
    actionButtons(app, life, IDLE_ACTIONS),
    h('div', { class: 'section-subtitle' }, tm('gestures')),
    actionButtons(app, life, GESTURES),
    h('div', { class: 'muted small' }, tm('hint')),
  );
  el.classList.add('mate-section');

  return {
    el,
    refresh() {
      enabled.set(mateFlag.enabled);
      rate.set(mate.actions);
      intensity.set(mate.intensity);
      stance.set(life.currentStance);
      controls.set(mate.controls);
    },
  };
}

/** The radial menu's "Actions" ring: the switch, standing stances, then the things it can do. */
export function mateMenu(app: App, life: LifeMotion) {
  const stances: Stance[] = ['side', 'front', 'back'];
  const names: ActionName[] = ['stretch', 'wave', 'bow', 'look', 'yawn', 'hair', 'sway', 'doze', 'neck', 'hands'];
  return [
    { label: tm('radialToggle'), active: () => mateFlag.enabled, run: () => { app.setMateEnabled(!mateFlag.enabled); } },
    ...stances.map((s) => ({
      label: tm(`stance.${s}`),
      active: () => mateFlag.enabled && life.currentStance === s,
      run: () => {
        if (!mateFlag.enabled) app.setMateEnabled(true);
        life.setStance(s);
        app.markActive();
      },
    })),
    ...names.map((n) => ({ label: tm(`action.${n}`), run: () => playAction(app, life, n) })),
  ];
}
