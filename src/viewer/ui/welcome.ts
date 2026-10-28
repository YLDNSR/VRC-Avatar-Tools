import type { App } from '../app';
import { h, icon, clear } from '../../shared/dom';
import { t } from '../../shared/i18n';
import { general } from '../settings';
import type { ViewerBridge } from '../../shared/bridge';

const vav = (window as any).vav as ViewerBridge;

export function createWelcome(app: App) {
  const recentList = h('div', { class: 'recent-list' });
  const el = h('div', { class: 'welcome' },
    h('div', { class: 'welcome-card' },
      h('div', { class: 'logo' }, icon('user', 44)),
      h('h1', {}, 'VRC Avatar Tools'),
      h('p', { class: 'muted' }, 'for macOS'),
      h('p', { class: 'drop-hint' }, t('welcome.subtitle')),
      h('div', { class: 'welcome-actions' },
        h('button', { class: 'btn primary', onclick: () => app.openAvatarDialog() }, icon('file', 18), t('welcome.openFile')),
        h('button', { class: 'btn', onclick: () => app.openFolderDialog() }, icon('open', 18), t('welcome.fromFolder')),
      ),
      h('p', { class: 'muted small' }, t('welcome.formats')),
      h('p', { class: 'muted small' }, t('welcome.vrchatHint')),
      recentList,
      h('button', { class: 'btn ghost', onclick: () => vav.openCapture() }, icon('camera', 16), t('welcome.openCapture')),
    ),
  );

  function refresh() {
    clear(recentList);
    if (!general.recent.length) return;
    recentList.appendChild(h('div', { class: 'section-title' }, t('welcome.recent')));
    for (const r of general.recent) {
      recentList.appendChild(h('button', {
        class: 'recent-item', title: r.path,
        onclick: () => { app.cameFromFolder = false; app.loadAvatar(r.path); },
      }, h('span', { class: 'name' }, r.title), h('span', { class: 'path muted' }, r.path.replace(/^\/Users\/[^/]+/, '~'))));
    }
  }
  refresh();
  return { el, refresh };
}
