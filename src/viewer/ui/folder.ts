// "폴더에서 선택": thumbnail grid of avatar files with search.
import type { App } from '../app';
import { h, icon, clear } from '../../shared/dom';
import { t } from '../../shared/i18n';
import { general } from '../settings';
import type { FolderAvatar, ViewerBridge } from '../../shared/bridge';

const vav = (window as any).vav as ViewerBridge;

export function createFolderBrowser(app: App) {
  let items: FolderAvatar[] = [];
  let dir = '';
  const pathEl = h('div', { class: 'folder-path' });
  const filterNote = h('div', { class: 'filter-note hidden' }, t('folder.filtering'));
  const search = h('input', { type: 'search', placeholder: t('folder.search'), spellcheck: false }) as HTMLInputElement;
  const clearBtn = h('button', { class: 'icon-btn small', title: '×', onclick: () => { search.value = ''; render(); search.focus(); } }, '×');
  const grid = h('div', { class: 'avatar-grid' });
  const el = h('div', { class: 'folder-view' },
    h('div', { class: 'folder-top' },
      h('div', { class: 'folder-head' }, pathEl, filterNote),
      h('div', { class: 'search-box' }, icon('search', 16), search, clearBtn),
    ),
    grid,
    h('div', { class: 'folder-bottom' },
      h('button', { class: 'btn', onclick: () => app.showWelcome() }, icon('back', 16), t('folder.back')),
      h('button', { class: 'btn', onclick: () => app.openFolderDialog() }, icon('open', 16), t('folder.reselect')),
    ),
  );
  search.addEventListener('input', render);

  function render() {
    const q = search.value.trim().toLowerCase();
    filterNote.classList.toggle('hidden', !q);
    clearBtn.classList.toggle('hidden', !q);
    clear(grid);
    const list = q ? items.filter((i) => i.title.toLowerCase().includes(q) || i.file.toLowerCase().includes(q) || i.author.toLowerCase().includes(q)) : items;
    if (!items.length) { grid.appendChild(h('div', { class: 'empty muted' }, t('folder.empty'))); return; }
    if (!list.length) { grid.appendChild(h('div', { class: 'empty muted' }, t('folder.noMatch'))); return; }
    for (const it of list) {
      grid.appendChild(h('button', {
        class: 'avatar-card', title: it.path,
        onclick: () => { app.cameFromFolder = true; app.loadAvatar(it.path); },
      },
      it.thumbnail ? h('img', { src: it.thumbnail, alt: '' }) : h('div', { class: 'thumb-placeholder' }, icon('user', 40)),
      h('div', { class: 'card-title' }, it.title),
      h('div', { class: 'card-sub muted' }, `${it.version || ''} ${it.author ? '· ' + it.author : ''}`)));
    }
  }

  async function open(d: string) {
    if (!d) { app.openFolderDialog(); return; }
    dir = d;
    general.lastFolder = d;
    general.save();
    pathEl.textContent = d.replace(/^\/Users\/[^/]+/, '~');
    clear(grid);
    grid.appendChild(h('div', { class: 'empty muted' }, t('folder.loading')));
    items = await vav.listFolder(d);
    if (dir === d) render();
  }

  return { el, open, refresh: render };
}
