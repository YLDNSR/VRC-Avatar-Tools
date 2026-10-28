// Lighting: presets, direction, height, brightness, color temperature, lock, marker.
import type { App } from '../app';
import { h, slider, segmented, toggle, toast } from '../../shared/dom';
import { t } from '../../shared/i18n';
import { lighting, LIGHT_DEFAULTS, type LightPreset } from '../settings';
import { panelShell, button } from './common';

export function createLightingPanel(app: App) {
  const shell = panelShell(t('set.lighting'), () => app.togglePanel('lighting'), 'lighting-panel');
  const stage = app.stage;
  const changed = () => {
    lighting.save();
    stage.applyLighting();
    app.markActive();
  };

  const presets: LightPreset[] = ['default', 'left', 'right', 'top', 'front', 'custom'];
  const presetSeg = segmented(presets.map((p) => ({ value: p, label: t(`light.preset.${p}`) })), lighting.preset, (p) => {
    stage.setPreset(p as any);
    refresh();
    app.markActive();
  });

  const dir = slider({
    label: t('light.direction'), min: -180, max: 180, step: 1, value: lighting.azimuth, format: (v) => `${v.toFixed(0)}°`,
    onInput: (v) => { lighting.azimuth = v; changed(); },
    onReset: () => { lighting.azimuth = LIGHT_DEFAULTS.azimuth; changed(); return lighting.azimuth; },
  });
  const height = slider({
    label: t('light.height'), min: -90, max: 90, step: 1, value: lighting.elevation, format: (v) => `${v.toFixed(0)}°`,
    onInput: (v) => { lighting.elevation = v; changed(); },
    onReset: () => { lighting.elevation = LIGHT_DEFAULTS.elevation; changed(); return lighting.elevation; },
  });
  const bright = slider({
    label: t('light.brightness'), min: 0, max: 1, step: 0.01, value: lighting.brightness,
    onInput: (v) => { lighting.brightness = v; changed(); },
    onReset: () => { lighting.brightness = LIGHT_DEFAULTS.brightness; changed(); return lighting.brightness; },
  });
  const temp = slider({
    label: t('light.colorTemp'), min: 4200, max: 9600, step: 50, value: lighting.temperature, format: (v) => `${v.toFixed(0)}K`,
    onInput: (v) => { lighting.temperature = v; changed(); },
    onReset: () => { lighting.temperature = LIGHT_DEFAULTS.temperature; changed(); return lighting.temperature; },
  });
  const lockSeg = segmented([
    { value: 'world', label: t('light.lockWorld') },
    { value: 'avatar', label: t('light.lockAvatar') },
  ], lighting.lock, (v) => { lighting.lock = v as any; changed(); });
  const marker = toggle(t('light.marker'), lighting.marker, (v) => { lighting.marker = v; changed(); });

  shell.body.append(
    h('div', { class: 'row-label' }, t('light.preset')),
    presetSeg.el,
    dir.el, height.el, bright.el, temp.el,
    button(t('light.saveCustom'), () => {
      lighting.custom = { azimuth: lighting.azimuth, elevation: lighting.elevation, brightness: lighting.brightness, temperature: lighting.temperature };
      lighting.preset = 'custom';
      lighting.save();
      refresh();
      toast(t('light.saveCustom'));
    }, 'small'),
    h('div', { class: 'row-label' }, t('light.lock')),
    lockSeg.el,
    marker.el,
    button(t('light.resetAll'), () => { stage.resetLighting(); refresh(); app.markActive(); }, 'ghost'),
  );

  function refresh() {
    presetSeg.set(lighting.preset);
    dir.set(lighting.azimuth);
    height.set(lighting.elevation);
    bright.set(lighting.brightness);
    temp.set(lighting.temperature);
    lockSeg.set(lighting.lock);
    marker.set(lighting.marker);
  }
  return { el: shell.el, refresh };
}
