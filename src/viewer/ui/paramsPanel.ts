// Expression / parameter panel for VRM / glTF avatars: the Menu view groups expressions by category,
// the All view lists every blendshape.
// With a VRChat sidecar (<name>.vavmeta.json) the panel is the avatar's Expression Menu exactly as in
// VRChat (same controls, labels and icons) and drives the avatar's animator (VrcAnimator / VrcFx).
import * as THREE from 'three';
import type { App } from '../app';
import type { Avatar } from '../avatar';
import type { VrcRuntime, VrcMenu, VrcControl } from '../vrcMeta';
import type { ManualState } from '../avatarState';
import { h, clear, segmented } from '../../shared/dom';
import { t } from '../../shared/i18n';
import { panelShell, button } from './common';

interface Param {
  key: string; // layer key, or "vis:<uuid>"
  label: string;
  kind: 'float' | 'bool' | 'int';
  get(): number;
  set(v: number): void;
  def: number;
  min?: number;
  max?: number;
}

const EMOTION = ['happy', 'angry', 'sad', 'relaxed', 'surprised', 'neutral'];
const MOUTH = ['aa', 'ih', 'ou', 'ee', 'oh'];
const EYES = ['blink', 'blinkLeft', 'blinkRight'];
const GAZE = ['lookUp', 'lookDown', 'lookLeft', 'lookRight'];

export function createParamsPanel(app: App) {
  const shell = panelShell(t('set.exprParams'), () => app.togglePanel('params'), 'params-panel');
  let view: 'menu' | 'all' = 'menu';
  const values = new Map<string, number>();
  const visibility = new Map<string, boolean>();
  let forAvatar: Avatar | null = null;
  // Open Expression submenus (with the control that opened each one) and the scroll position of each level.
  const menuStack: { menu: VrcMenu; control: VrcControl }[] = [];
  const scrollMemo: number[] = [];
  // Refreshes requested by the animator while a slider is being dragged wait for the release.
  let pointerDown = false;
  let pendingRefresh = false;

  const viewSeg = segmented([
    { value: 'menu', label: t('params.menu') },
    { value: 'all', label: t('params.all') },
  ], view, (v) => { view = v as any; render(); });
  const search = h('input', { type: 'search', placeholder: t('params.search'), class: 'params-search' }) as HTMLInputElement;
  search.addEventListener('input', () => render());
  const list = h('div', { class: 'params-list' });
  const resetAll = button(t('params.resetAll'), () => {
    values.clear();
    for (const [uuid] of visibility) setVisible(uuid, true);
    visibility.clear();
    menuStack.length = 0;
    scrollMemo.length = 0;
    app.vrc?.reset();
    push();
    render();
  }, 'ghost small');
  const top = h('div', { class: 'params-top' }, viewSeg.el, search);
  shell.body.append(top, list, resetAll);
  list.addEventListener('pointerdown', () => { pointerDown = true; });
  window.addEventListener('pointerup', () => {
    pointerDown = false;
    if (pendingRefresh) { pendingRefresh = false; render(); }
  });

  function avatarChanged() {
    if (forAvatar === app.avatar) return;
    forAvatar = app.avatar;
    values.clear();
    visibility.clear();
    menuStack.length = 0;
    scrollMemo.length = 0;
  }

  function push() {
    const a = app.avatar;
    if (!a) return;
    a.setLayer('manual', new Map(values));
    app.markActive();
    app.rememberAvatarState();
  }

  /** Manual values with keys that survive reloading the avatar (mesh / blendshape and object names, not uuids). */
  function manualState(): ManualState | null {
    const a = app.avatar;
    if (!a || forAvatar !== a) return null;
    const morphs: Record<string, number> = {};
    for (const [k, v] of values) {
      if (k.startsWith('e:')) { morphs[k] = v; continue; }
      const ref = a.morphByKey.get(k);
      if (ref) morphs[`${ref.mesh.name}\u0000${ref.name}`] = v;
    }
    const hidden: string[] = [];
    a.scene.traverse((o) => { if (visibility.get(o.uuid) === false) hidden.push(o.name); });
    return { morphs, hidden };
  }

  function restoreManual(a: Avatar, st: ManualState) {
    forAvatar = a;
    values.clear();
    visibility.clear();
    for (const [k, v] of Object.entries(st.morphs || {})) {
      if (typeof v !== 'number') continue;
      if (k.startsWith('e:')) { if (a.expression(k.slice(2))) values.set(k, v); continue; }
      const [mesh, shape] = k.split('\u0000');
      for (const r of a.morphs) if (r.mesh.name === mesh && r.name === shape) values.set(r.key, v);
    }
    const hidden = new Set(st.hidden || []);
    // GLTFLoader gives every node a unique name, so names find the same objects again.
    a.scene.traverse((o) => { if (hidden.has(o.name)) { visibility.set(o.uuid, false); o.visible = false; } });
    a.setLayer('manual', new Map(values));
  }

  function setVisible(uuid: string, v: boolean) {
    const a = app.avatar;
    if (!a) return;
    a.scene.traverse((o) => { if (o.uuid === uuid) o.visible = v; });
  }

  function exprParam(a: Avatar, name: string, label = name): Param | null {
    const keys = a.resolveExpression(name);
    if (!keys.length) return null;
    const key = keys[0];
    return {
      key, label, kind: 'float', def: 0,
      get: () => values.get(key) ?? 0,
      set: (v) => { for (const k of keys) { if (v === 0) values.delete(k); else values.set(k, v); } push(); },
    };
  }

  function morphParam(key: string, label: string): Param {
    return {
      key, label, kind: 'float', def: 0,
      get: () => values.get(key) ?? 0,
      set: (v) => { if (v === 0) values.delete(key); else values.set(key, v); push(); },
    };
  }

  function objectParams(a: Avatar): Param[] {
    const out: Param[] = [];
    const seen = new Set<THREE.Object3D>();
    for (const m of a.meshes) {
      // toggle the mesh's own node (or its group parent when the mesh is a primitive)
      const node = m.parent && m.parent !== a.scene && (m.parent as any).isMesh !== true && m.parent.children.every((c) => (c as any).isMesh) ? m.parent : m;
      if (seen.has(node)) continue;
      seen.add(node);
      const uuid = node.uuid;
      out.push({
        key: `vis:${uuid}`, label: node.name || '(mesh)', kind: 'bool', def: 1,
        get: () => (visibility.has(uuid) ? (visibility.get(uuid) ? 1 : 0) : 1),
        set: (v) => { const on = v >= 0.5; if (on) visibility.delete(uuid); else visibility.set(uuid, false); setVisible(uuid, on); app.markActive(); app.rememberAvatarState(); },
      });
    }
    return out;
  }

  function categories(a: Avatar): { id: string; title: string; params: Param[] }[] {
    const pick = (names: string[]) => names.map((n) => exprParam(a, n)).filter(Boolean) as Param[];
    const cats = [
      { id: 'Expressions', title: t('params.cat.Expressions'), params: pick(EMOTION) },
      { id: 'mouth', title: t('params.cat.mouth'), params: pick(MOUTH) },
      { id: 'eyes', title: t('params.cat.eyes'), params: pick(EYES) },
      { id: 'gaze', title: t('params.cat.gaze'), params: pick(GAZE) },
    ];
    const known = new Set([...EMOTION, ...MOUTH, ...EYES, ...GAZE].map((n) => n.toLowerCase()));
    const custom = a.expressionNames.filter((n) => !known.has(n.toLowerCase())).map((n) => exprParam(a, n)).filter(Boolean) as Param[];
    cats.push({ id: 'custom', title: t('params.cat.custom'), params: custom });
    cats.push({ id: 'objects', title: t('params.cat.objects'), params: objectParams(a) });
    return cats.filter((c) => c.params.length);
  }

  function allMorphs(a: Avatar): { id: string; title: string; params: Param[] }[] {
    const byMesh = new Map<THREE.Mesh, Param[]>();
    for (const r of a.morphs) {
      if (!byMesh.has(r.mesh)) byMesh.set(r.mesh, []);
      byMesh.get(r.mesh)!.push(morphParam(r.key, r.name));
    }
    const out = [] as { id: string; title: string; params: Param[] }[];
    for (const [mesh, params] of byMesh) out.push({ id: mesh.uuid, title: `${t('params.cat.morphs')} · ${mesh.name || mesh.parent?.name || 'mesh'}`, params });
    const exprs = a.expressionNames.map((n) => exprParam(a, n)).filter(Boolean) as Param[];
    if (exprs.length) out.unshift({ id: 'vrm', title: 'VRM Expressions', params: exprs });
    return out;
  }

  function paramRow(p: Param, onChange: () => void, iconEl: HTMLElement | null = null) {
    const changed = p.get() !== p.def;
    const label = h('span', { class: 'label', title: p.label }, p.label);
    if (p.kind === 'bool') {
      const input = h('input', { type: 'checkbox' }) as HTMLInputElement;
      input.checked = p.get() >= 0.5;
      input.addEventListener('change', () => { p.set(input.checked ? 1 : 0); onChange(); });
      return h('label', { class: `param-row ${changed ? 'changed' : ''} ${input.checked ? 'on' : ''}` }, iconEl, label, h('span', { class: 'switch' }, input, h('span', { class: 'knob' })));
    }
    if (p.kind === 'int') {
      const num = h('input', { type: 'number', min: String(p.min ?? 0), max: String(p.max ?? 255), step: '1', class: 'param-int' }) as HTMLInputElement;
      num.value = String(p.get());
      num.addEventListener('change', () => { p.set(parseInt(num.value, 10) || 0); onChange(); });
      return h('label', { class: `param-row ${changed ? 'changed' : ''}` }, iconEl, label, num);
    }
    const input = h('input', { type: 'range', min: String(p.min ?? 0), max: String(p.max ?? 1), step: '0.01' }) as HTMLInputElement;
    input.value = String(p.get());
    const out = h('span', { class: 'value' }, `${Math.round(p.get() * 100)}`);
    input.addEventListener('input', () => {
      p.set(parseFloat(input.value));
      out.textContent = `${Math.round(parseFloat(input.value) * 100)}`;
      row.classList.toggle('changed', p.get() !== p.def);
    });
    input.addEventListener('change', onChange);
    const row = h('label', { class: `param-row ${changed ? 'changed' : ''}` }, iconEl, label, input, out);
    return row;
  }

  // ---------------------------------------------------------------------------
  // VRChat Expression Menu (sidecar)

  function vrcIcon(fx: VrcRuntime, index: number | undefined) {
    const src = index !== undefined && index >= 0 ? fx.icons[index] : '';
    return src ? h('img', { class: 'vrc-icon', src, alt: '' }) : h('span', { class: 'vrc-icon none' });
  }

  function fxParam(fx: VrcRuntime, name: string, label: string, opts: { min?: number; max?: number } = {}): Param {
    const type = fx.typeOf(name);
    const kind = type === 'bool' ? 'bool' : type === 'int' ? 'int' : 'float';
    const def = fx.defaultOf(name);
    return {
      key: `vrc:${name}`, label, kind, def,
      min: opts.min ?? (kind === 'float' && def < 0 ? -1 : 0), max: opts.max,
      get: () => fx.get(name),
      set: (v) => fx.set(name, v),
    };
  }

  /** Toggle control: on while the parameter equals the control value; off sets 0 (VRChat semantics). */
  function toggleParam(fx: VrcRuntime, c: VrcControl): Param {
    const name = c.parameter!;
    const on = c.value ?? 1;
    const is = (v: number) => (Math.abs(v - on) < 1e-4 ? 1 : 0);
    return {
      key: `vrc:${name}:${on}`, label: c.name, kind: 'bool', def: is(fx.defaultOf(name)),
      get: () => is(fx.get(name)),
      set: (v) => fx.set(name, v >= 0.5 ? on : 0),
    };
  }

  function controlRows(fx: VrcRuntime, c: VrcControl): HTMLElement[] {
    const sub = (c.subParameters || []).filter(Boolean);
    switch (c.type) {
      case 'toggle':
        return c.parameter ? [paramRow(toggleParam(fx, c), render, vrcIcon(fx, c.icon))] : [];
      case 'button': {
        if (!c.parameter) return [];
        const name = c.parameter;
        const value = c.value ?? 1;
        const release = () => fx.set(name, 0);
        const b = h('button', { class: 'btn tiny' }, t('params.vrcHold'));
        b.addEventListener('pointerdown', () => fx.set(name, value));
        b.addEventListener('pointerup', release);
        b.addEventListener('pointerleave', release);
        return [h('div', { class: 'param-row' }, vrcIcon(fx, c.icon), h('span', { class: 'label', title: c.name }, c.name), b)];
      }
      case 'subMenu': {
        const menu = c.menu;
        if (!menu) return [];
        const open = () => {
          if (c.parameter) fx.set(c.parameter, c.value ?? 1);
          scrollMemo[menuStack.length] = shell.body.scrollTop;
          menuStack.push({ menu, control: c });
          render();
          shell.body.scrollTop = 0;
        };
        return [h('button', { class: 'param-row vrc-submenu', onclick: open }, vrcIcon(fx, c.icon), h('span', { class: 'label', title: c.name }, c.name), h('span', { class: 'chevron' }, '›'))];
      }
      case 'radialPuppet':
        return sub.length ? [paramRow(fxParam(fx, sub[0], c.name, { min: 0, max: 1 }), render, vrcIcon(fx, c.icon))] : [];
      case 'twoAxisPuppet':
        return sub.slice(0, 2).map((p, i) => paramRow(fxParam(fx, p, `${c.name} ${i === 0 ? '↔' : '↕'}`, { min: -1, max: 1 }), render, i === 0 ? vrcIcon(fx, c.icon) : vrcIcon(fx, -1)));
      case 'fourAxisPuppet':
        return sub.slice(0, 4).map((p, i) => paramRow(fxParam(fx, p, `${c.name} ${c.labels?.[i] || '↑→↓←'[i]}`, { min: 0, max: 1 }), render, vrcIcon(fx, c.labelIcons?.[i] ?? (i === 0 ? c.icon : -1))));
      default:
        return [];
    }
  }

  function closeSubmenu(fx: VrcRuntime) {
    const top = menuStack.pop();
    if (top?.control.parameter) fx.set(top.control.parameter, 0);
    render();
    shell.body.scrollTop = scrollMemo[menuStack.length] ?? 0;
  }

  function renderVrcMenu(fx: VrcRuntime) {
    const root = fx.meta.menu;
    if (!root || !root.controls?.length) {
      list.appendChild(h('div', { class: 'empty muted' }, t('params.vrcNoMenu')));
      return;
    }
    const menu = menuStack.length ? menuStack[menuStack.length - 1].menu : root;
    const crumbs = [t('params.vrcRoot'), ...menuStack.map((m) => m.control.name)].join(' › ');
    const body = h('div', { class: 'param-cat-body vrc-menu' });
    for (const c of menu.controls || []) for (const row of controlRows(fx, c)) body.appendChild(row);
    const back = menuStack.length
      ? h('button', { class: 'btn tiny', title: t('folder.back'), onclick: (e: Event) => { e.preventDefault(); closeSubmenu(fx); } }, '‹')
      : null;
    list.appendChild(h('div', { class: 'param-cat' }, h('div', { class: 'vrc-crumbs' }, back, h('span', {}, crumbs)), body));
  }

  function render() {
    if (pointerDown && list.querySelector('input[type=range]:active, input[type=range]:focus')) { pendingRefresh = true; return; }
    avatarChanged();
    // Rebuilding the rows must not move the list (toggling used to jump back to the top).
    const scroll = shell.body.scrollTop;
    clear(list);
    const a = app.avatar;
    const fx = app.vrc;
    shell.setTitle(t(fx ? 'params.vrcTitle' : 'set.exprParams'));
    top.classList.toggle('hidden', !!fx);
    resetAll.textContent = t(fx ? 'params.vrcReset' : 'params.resetAll');
    if (!a) return;
    if (fx) {
      renderVrcMenu(fx);
      shell.body.scrollTop = scroll;
      return;
    }
    const mode = view;
    viewSeg.set(view);
    search.classList.toggle('hidden', mode === 'menu');
    const q = search.value.trim().toLowerCase();
    const cats = mode === 'menu' ? categories(a) : allMorphs(a);
    let total = 0;
    for (const c of cats) {
      const params = q ? c.params.filter((p) => p.label.toLowerCase().includes(q)) : c.params;
      if (!params.length) continue;
      total += params.length;
      const anyChanged = params.some((p) => p.get() !== p.def);
      const reset = h('button', {
        class: 'btn tiny', disabled: !anyChanged, onclick: () => { for (const p of params) p.set(p.def); render(); },
      }, t('anim.reset'));
      const body = h('div', { class: 'param-cat-body' });
      for (const p of params) body.appendChild(paramRow(p, render));
      list.appendChild(h('details', { class: 'param-cat', open: mode === 'menu' || !!q || cats.length < 3 },
        h('summary', {}, h('span', {}, `${c.title} (${params.length})`), reset), body));
    }
    if (!total) list.appendChild(h('div', { class: 'empty muted' }, t('params.none')));
    shell.body.scrollTop = scroll;
  }

  return { el: shell.el, refresh: render, manualState, restoreManual };
}
