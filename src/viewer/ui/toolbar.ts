// Bottom toolbar (appears when the mouse approaches the bottom of the window).
import type { App } from '../app';
import { h, icon } from '../../shared/dom';
import { t } from '../../shared/i18n';
import { general } from '../settings';
import { layoutSettings } from '../layout';
import { mateFlag } from '../mate/flag';

export function createToolbar(app: App) {
  const btn = (name: string, label: string, onclick: () => void, id?: string) =>
    h('button', { class: 'tb-btn', title: label, 'data-id': id || '', onclick }, icon(name, 20), h('span', { class: 'tb-label' }, label)) as HTMLButtonElement;

  const back = btn('back', t('tb.back'), () => {
    if (app.cameFromFolder && general.lastFolder) app.showFolder(general.lastFolder);
    else app.showWelcome();
  });
  const openFile = btn('file', t('tb.openFile'), () => app.openAvatarDialog());
  const anim = btn('film', t('tb.animation'), () => app.togglePanel('animation'), 'animation');
  const mateBtn = btn('mate', t('tb.mate'), () => { app.toggleDesktopMate(); }, 'mate');
  mateBtn.title = t('tb.mateHint');
  const transparent = btn('transparent', t('tb.transparent'), () => app.setTransparent(!app.transparent), 'transparent');
  const stream = btn('stream', t('tb.streaming'), () => app.togglePanel('streaming'), 'streaming');
  const settings = btn('settings', t('tb.settings'), () => app.togglePanel('settings'), 'settings');
  // Autonomous broadcast (beta): only while its switch is on.
  const cast = btn('mic', t('tb.autocast'), () => app.togglePanel('autocast'), 'autocast');
  // Locks the avatar's position / scale / rotation and the camera against mouse and keyboard.
  const lock = btn('unlock', t('tb.lock'), () => app.setLayoutLocked(!layoutSettings.locked), 'lock');
  const move = h('div', { class: 'tb-move', title: t('tb.move') }, icon('move', 18));

  const bar = h('div', { class: 'toolbar' }, back, openFile, h('span', { class: 'tb-sep' }), mateBtn, anim, transparent, stream, cast, lock, settings, move);
  const el = h('div', { class: 'toolbar-zone' }, bar);

  let forced = false;
  function refresh() {
    openFile.classList.toggle('hidden', app.cameFromFolder);
    mateBtn.classList.toggle('active', app.mateMode);
    mateBtn.classList.toggle('live', app.mateMode || mateFlag.enabled);
    transparent.classList.toggle('active', app.transparent && !app.mateMode);
    cast.classList.toggle('hidden', !app.autocast);
    cast.classList.toggle('live', !!app.autocast?.live());
    for (const b of [anim, stream, settings, cast]) {
      const panel = document.querySelector(`[data-panel="${b.dataset.id}"]`);
      b.classList.toggle('active', !!panel && !panel.classList.contains('hidden'));
    }
    stream.classList.toggle('live', app.streaming.running || app.syphon.running);
    lock.classList.toggle('active', layoutSettings.locked);
    lock.replaceChild(icon(layoutSettings.locked ? 'lock' : 'unlock', 20), lock.firstChild!);
    lock.title = t(layoutSettings.locked ? 'tb.unlockHint' : 'tb.lockHint');
    move.classList.toggle('hidden', !app.transparent);
    el.classList.toggle('force', forced);
  }

  return {
    el,
    refresh,
    setHover(v: boolean) {
      if (v === forced) return;
      forced = v;
      el.classList.toggle('force', v);
    },
  };
}
