// Face tracking window: type (VRM basic → Perfect Sync → VRCFT), availability, strength.
import type { App } from '../app';
import { h, slider } from '../../shared/dom';
import { t } from '../../shared/i18n';
import { streaming as settings, type FaceType } from '../settings';
import { panelShell, button } from './common';

const ORDER: FaceType[] = ['vrm', 'ps', 'vrcft'];
const CATS = ['blink', 'gaze', 'brow', 'mouth', 'emotion', 'other'];

export function createFacePanel(app: App) {
  const shell = panelShell(t('st.faceTracking'), () => app.togglePanel('face'), 'face-panel');
  const typeBtn = button('', () => {
    settings.faceType = ORDER[(ORDER.indexOf(settings.faceType) + 1) % ORDER.length];
    settings.save();
    if (app.streaming.running) app.streaming.start();
    refresh();
    app.rerenderUI();
  }, 'primary type-btn');
  const available = h('div', { class: 'available' });
  const strengths = CATS.map((c) => slider({
    label: t(`ft.cat.${c}`), min: 0, max: 2, step: 0.01, value: settings.strength[c] ?? 1, format: (v) => `${Math.round(v * 100)}%`,
    onInput: (v) => { settings.strength[c] = v; settings.save(); },
    onReset: () => { settings.strength[c] = 1; settings.save(); return 1; },
  }));
  const vrcftNote = h('div', { class: 'muted small' }, t('ft.vrcftNote'));
  const portNote = h('div', { class: 'muted small' });

  shell.body.append(
    h('div', { class: 'row' }, h('span', { class: 'label' }, t('ft.type')), typeBtn),
    available,
    h('div', { class: 'section-title' }, t('ft.strength')),
    ...strengths.map((s) => s.el),
    vrcftNote,
    portNote,
  );

  function refresh() {
    typeBtn.textContent = t(`ft.type.${settings.faceType}`);
    const a = app.avatar;
    const sup = a ? a.faceSupport() : null;
    const names: string[] = [];
    if (sup?.vrm) names.push(t('ft.type.vrm'));
    if (sup?.perfectSync) names.push(`${t('ft.type.ps')} (${sup.perfectSyncCount}/52)`);
    if (sup?.vrcft) names.push(`${t('ft.type.vrcft')}${sup.ueCount ? ` (UE ${sup.ueCount})` : ''}`);
    available.textContent = `${t('ft.available')} ${names.length ? names.join(' / ') : t('st.profile.none')}`;
    const vrcft = settings.faceType === 'vrcft';
    strengths.forEach((s, i) => { s.setDisabled(vrcft); s.set(settings.strength[CATS[i]] ?? 1); });
    vrcftNote.classList.toggle('hidden', !vrcft);
    portNote.textContent = vrcft ? `${t('ft.vrcftPort')} (${t('st.oscPort')}: ${settings.oscPort})` : '';
  }
  refresh();
  return { el: shell.el, refresh };
}
