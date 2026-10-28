// Animation player panel: single / playlist / sets (max 10 sets × 10 items).
import type { App } from '../app';
import { h, icon, clear, slider, segmented, toast } from '../../shared/dom';
import { t } from '../../shared/i18n';
import { animation as settings, type AnimItem } from '../settings';
import { animItemFromPath } from '../animation';
import { panelShell, section, button } from './common';
import type { ViewerBridge } from '../../shared/bridge';
import { VrcAnimator } from '../vrcAnimator';

const vav = (window as any).vav as ViewerBridge;
const MAX = 10;

export function createAnimationPanel(app: App) {
  const shell = panelShell(t('anim.title'), () => app.togglePanel('animation'), 'anim-panel');
  const player = app.player;

  const modeSeg = segmented([
    { value: 'single', label: t('anim.single') },
    { value: 'playlist', label: t('anim.playlist') },
    { value: 'sets', label: t('anim.sets') },
  ], settings.mode, (v) => { settings.mode = v as any; settings.save(); player.refreshLoop(); render(); });

  const nowPlaying = h('div', { class: 'now-playing muted' });
  const listBox = h('div', { class: 'anim-list' });
  const setRow = h('div', { class: 'set-row' });
  const note = h('div', { class: 'muted small' }, t('anim.dropHint'));
  // Animations built into a VRChat avatar (sidecar v2): dances, AFK, idle … plus VRChat's AFK state.
  const avatarBox = h('div', { class: 'avatar-anims' });

  const playBtn = h('button', { class: 'icon-btn', title: t('anim.play'), onclick: () => togglePlay() }, icon('play', 18));
  const stopBtn = h('button', { class: 'icon-btn', title: t('anim.stop'), onclick: () => player.stop() }, icon('stop', 18));
  const prevBtn = h('button', { class: 'icon-btn', title: t('anim.prev'), onclick: () => player.prev() }, icon('prev', 18));
  const nextBtn = h('button', { class: 'icon-btn', title: t('anim.next'), onclick: () => player.next() }, icon('next', 18));
  const repeatBtn = h('button', { class: 'icon-btn repeat', onclick: () => cycleRepeat() }, icon('repeat', 18), h('span', { class: 'repeat-mode' }));
  const openBtn = button(t('anim.open'), () => openFiles(), 'small');
  const controls = h('div', { class: 'transport' }, openBtn, prevBtn, playBtn, stopBtn, nextBtn, repeatBtn);

  const speed = slider({
    label: t('anim.speed'), min: 0.1, max: 2, step: 0.05, value: settings.speed, format: (v) => `${v.toFixed(2)}×`,
    onInput: (v) => { settings.speed = v; settings.save(); player.setSpeed(v); },
    onReset: () => { settings.speed = 1; settings.save(); player.setSpeed(1); return 1; },
  });
  const stand = slider({
    label: t('anim.standSize'), min: 0.3, max: 3, step: 0.01, value: settings.standSize,
    onInput: (v) => { settings.standSize = v; settings.save(); app.markActive(); },
    onReset: () => { settings.standSize = 1; settings.save(); app.markActive(); return 1; },
  });
  const yOff = slider({
    label: t('anim.yOffset'), min: -0.5, max: 0.5, step: 0.005, value: settings.yOffset, format: (v) => `${(v * 100).toFixed(1)} cm`,
    onInput: (v) => { settings.yOffset = v; settings.save(); app.markActive(); },
    onReset: () => { settings.yOffset = 0; settings.save(); app.markActive(); return 0; },
  });

  shell.body.append(
    modeSeg.el,
    nowPlaying,
    controls,
    setRow,
    listBox,
    note,
    avatarBox,
    section('', speed.el, stand.el, yOff.el, button(t('anim.faceFront'), () => app.faceFront())),
  );

  player.onChange = () => render();
  player.onError = (item, err) => toast(`${t('anim.loadFailed')}: ${item.name} (${(err as Error).message || err})`, 5000);

  function currentList(): AnimItem[] {
    if (settings.mode === 'playlist') return settings.playlist;
    if (settings.mode === 'sets') return settings.sets[settings.activeSet]?.items || [];
    return settings.lastSingle ? [settings.lastSingle] : [];
  }

  function cycleRepeat() {
    const order: typeof settings.repeat[] = settings.mode === 'single' ? ['one', 'off'] : ['all', 'one', 'off'];
    const i = order.indexOf(settings.repeat);
    settings.repeat = order[(i + 1) % order.length];
    settings.save();
    player.refreshLoop();
    render();
  }

  async function playItem(list: AnimItem[], index: number) {
    if (!app.avatar) { toast(t('anim.needAvatar')); return; }
    if (settings.mode === 'single') {
      try { await player.play(list[index]); } catch (err) { player.onError?.(list[index], err); }
    } else {
      await player.playQueue(list, index);
    }
    if (list[index] && /\.anim$/i.test(list[index].path)) toast(t('anim.approx'), 2500);
    if (player.warnings.length) console.warn('[anim]', player.warnings);
  }

  function togglePlay() {
    if (player.active) { player.pause(); return; }
    const list = currentList();
    if (list.length) playItem(list, 0);
    else openFiles();
  }

  async function openFiles() {
    const paths = await vav.dialog.openAnimations(settings.mode !== 'single');
    if (paths.length) addFiles(paths.map(animItemFromPath));
  }

  function addFiles(items: AnimItem[]) {
    if (settings.mode === 'single') {
      settings.lastSingle = items[0];
      settings.save();
      playItem([items[0]], 0);
    } else {
      const list = currentList();
      if (settings.mode === 'sets' && !settings.sets.length) {
        settings.sets.push({ name: t('anim.setName', { n: 1 }), items: [] });
        settings.activeSet = 0;
      }
      const target = settings.mode === 'playlist' ? settings.playlist : settings.sets[settings.activeSet].items;
      for (const it of items) {
        if (target.length >= MAX) { toast(t('anim.listFull')); break; }
        target.push(it);
      }
      settings.save();
      if (!player.active && list.length === 0 && target.length) playItem(target, 0);
    }
    render();
  }

  function render() {
    modeSeg.set(settings.mode);
    const cur = player.current;
    nowPlaying.textContent = cur ? `▶ ${cur.name}` : t('anim.nothing');
    clear(playBtn); playBtn.appendChild(icon(player.playing ? 'pause' : 'play', 18));
    playBtn.title = player.playing ? t('anim.pause') : t('anim.play');
    const single = settings.mode === 'single';
    prevBtn.classList.toggle('hidden', single);
    nextBtn.classList.toggle('hidden', single);
    if (single && settings.repeat === 'all') settings.repeat = 'one';
    (repeatBtn.querySelector('.repeat-mode') as HTMLElement).textContent =
      settings.repeat === 'off' ? t('anim.repeatOff') : settings.repeat === 'one' ? t('anim.repeatOne') : t('anim.repeatAll');
    repeatBtn.classList.toggle('active', settings.repeat !== 'off');

    // Sets selector
    clear(setRow);
    if (settings.mode === 'sets') {
      const sel = h('select', {
        onchange: () => { settings.activeSet = parseInt(sel.value, 10); settings.save(); render(); },
      }) as HTMLSelectElement;
      settings.sets.forEach((s, i) => sel.appendChild(h('option', { value: String(i) }, s.name)));
      if (settings.activeSet >= settings.sets.length) settings.activeSet = Math.max(0, settings.sets.length - 1);
      sel.value = String(settings.activeSet);
      setRow.append(
        sel,
        h('button', {
          class: 'icon-btn', title: t('anim.newSet'), onclick: () => {
            if (settings.sets.length >= MAX) { toast(t('anim.setFull')); return; }
            settings.sets.push({ name: t('anim.setName', { n: settings.sets.length + 1 }), items: settings.playlist.slice(0, MAX) });
            settings.activeSet = settings.sets.length - 1;
            settings.save();
            render();
          },
        }, icon('plus', 16)),
        h('button', {
          class: 'icon-btn', title: t('anim.renameSet'), onclick: () => {
            const s = settings.sets[settings.activeSet];
            if (!s) return;
            const input = h('input', { type: 'text', value: s.name, class: 'rename-input' }) as HTMLInputElement;
            input.addEventListener('change', () => { s.name = input.value.trim() || s.name; settings.save(); render(); });
            input.addEventListener('blur', () => render());
            setRow.replaceChild(input, sel);
            input.focus();
            input.select();
          },
        }, '✎'),
        h('button', {
          class: 'icon-btn', title: t('anim.deleteSet'), onclick: () => {
            if (!settings.sets.length) return;
            settings.sets.splice(settings.activeSet, 1);
            settings.activeSet = Math.max(0, settings.activeSet - 1);
            settings.save();
            render();
          },
        }, icon('trash', 16)),
      );
    }

    clear(listBox);
    if (settings.mode !== 'single') {
      const list = currentList();
      if (!list.length) listBox.appendChild(h('div', { class: 'empty muted small' }, t('anim.empty')));
      list.forEach((it, i) => {
        const playingThis = player.current?.path === it.path;
        listBox.appendChild(h('div', { class: `anim-item ${playingThis ? 'playing' : ''}` },
          h('button', { class: 'anim-name', title: it.path, onclick: () => playItem(list, i) }, `${i + 1}. ${it.name}`),
          h('button', {
            class: 'icon-btn small', title: t('anim.remove'), onclick: () => { list.splice(i, 1); settings.save(); render(); },
          }, icon('close', 14)),
        ));
      });
      const actions = h('div', { class: 'row-actions' },
        button(t('anim.add'), () => openFiles(), 'small'),
        list.length ? button(t('anim.clear'), () => { list.splice(0, list.length); settings.save(); render(); }, 'small ghost') : null,
      );
      listBox.appendChild(actions);
    } else if (settings.lastSingle) {
      listBox.appendChild(h('div', { class: `anim-item ${player.current?.path === settings.lastSingle.path ? 'playing' : ''}` },
        h('button', { class: 'anim-name', title: settings.lastSingle.path, onclick: () => playItem([settings.lastSingle!], 0) }, settings.lastSingle.name)));
    }
    renderAvatarAnimations();
    speed.set(settings.speed);
    stand.set(settings.standSize);
    yOff.set(settings.yOffset);
  }

  function renderAvatarAnimations() {
    clear(avatarBox);
    const fx = app.vrc;
    if (!(fx instanceof VrcAnimator)) return;
    const anims = fx.animations();
    const body = h('div', { class: 'anim-list' });
    for (const a of anims) {
      const item = { path: `avatar-clip:${a.clip}`, name: a.name };
      const playingThis = player.current?.path === item.path;
      body.appendChild(h('div', { class: `anim-item ${playingThis ? 'playing' : ''}` },
        h('button', {
          class: 'anim-name', title: `${a.name} (${a.length.toFixed(1)} s)`,
          onclick: async () => { try { await player.play(item); } catch (err) { player.onError?.(item, err); } },
        }, a.name)));
    }
    if (!anims.length) body.appendChild(h('div', { class: 'empty muted small' }, t('anim.avatarNone')));
    // VRChat sets AFK when the player is away; the avatar's own AFK animation then plays.
    const afk = h('input', { type: 'checkbox' }) as HTMLInputElement;
    afk.checked = fx.get('AFK') >= 0.5;
    afk.addEventListener('change', () => { fx.set('AFK', afk.checked ? 1 : 0); app.markActive(); });
    const afkRow = h('label', { class: 'param-row' }, h('span', { class: 'label' }, t('anim.afk')), h('span', { class: 'switch' }, afk, h('span', { class: 'knob' })));
    avatarBox.append(section(t('anim.avatar'), h('div', { class: 'muted small' }, t('anim.avatarHint')), body, afkRow));
  }

  render();
  return { el: shell.el, refresh: render, addFiles };
}
