// Radial quick menu: right-click the avatar (most useful with a transparent background) to get the avatar's
// Expression Menu as a ring around the cursor, like VRChat's Action Menu, plus a few app actions.
// Toggles light up, buttons act while held, sub menus open in place, a radial puppet becomes a dial and
// two / four axis puppets a stick. The centre goes back (or closes at the top).
import type { App } from '../app';
import type { ViewerBridge } from '../../shared/bridge';
import type { VrcControl, VrcMenu, VrcRuntime } from '../vrcMeta';
import { h, icon } from '../../shared/dom';
import { t } from '../../shared/i18n';
import { layoutSettings } from '../layout';

const SVG_NS = 'http://www.w3.org/2000/svg';
const vav = (window as any).vav as ViewerBridge;

interface Item {
  label: string;
  iconSrc?: string;
  iconName?: string;
  active?: () => boolean;
  /** Small text under the label (puppet value) */
  detail?: () => string;
  onClick?: () => void;
  onDown?: () => void;
  onUp?: () => void;
  /** Destructive action (shown in red) */
  danger?: boolean;
}

interface Level {
  title: string;
  items: () => Item[];
  /** Expression Menu control that opened this level (its parameter is reset when it closes) */
  control?: VrcControl;
}

type Mode =
  | { kind: 'ring' }
  | { kind: 'dial'; control: VrcControl }
  | { kind: 'stick'; control: VrcControl; four: boolean };

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function capture(target: Element, e: PointerEvent) {
  try { target.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
}

function release(target: Element, e: PointerEvent) {
  if (target.hasPointerCapture(e.pointerId)) target.releasePointerCapture(e.pointerId);
}

/** Annular sector; angles in radians, 0 at the top, clockwise. */
function sector(c: number, r1: number, r2: number, a0: number, a1: number) {
  const p = (r: number, a: number) => `${(c + r * Math.sin(a)).toFixed(2)} ${(c - r * Math.cos(a)).toFixed(2)}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${p(r2, a0)} A${r2} ${r2} 0 ${large} 1 ${p(r2, a1)} L${p(r1, a1)} A${r1} ${r1} 0 ${large} 0 ${p(r1, a0)} Z`;
}

export function createRadialMenu(app: App) {
  const el = h('div', { class: 'radial hidden' });
  const center = h('button', { class: 'radial-center' });
  el.appendChild(center);
  let size = 300;
  let outer = 140;
  let inner = 46;
  const stack: Level[] = [];
  let mode: Mode = { kind: 'ring' };
  let hoverLabel = '';
  let held: Item | null = null;
  /** Centre of the open menu (window coordinates) */
  const at = { x: 0, y: 0 };

  const fx = () => app.vrc as VrcRuntime | null;

  // -------------------------------------------------------------------------
  // Items

  function controlItems(menu: VrcMenu): Item[] {
    const f = fx();
    if (!f) return [];
    return (menu.controls || []).map((c) => controlItem(f, c)).filter(Boolean) as Item[];
  }

  function controlItem(f: VrcRuntime, c: VrcControl): Item | null {
    const iconSrc = c.icon !== undefined && c.icon >= 0 ? f.icons[c.icon] : undefined;
    const base = { label: c.name, iconSrc };
    const sub = (c.subParameters || []).filter(Boolean);
    switch (c.type) {
      case 'toggle': {
        if (!c.parameter) return null;
        const p = c.parameter;
        const on = c.value ?? 1;
        const is = () => Math.abs(f.get(p) - on) < 1e-4;
        return { ...base, active: is, onClick: () => f.set(p, is() ? 0 : on) };
      }
      case 'button': {
        if (!c.parameter) return null;
        const p = c.parameter;
        return { ...base, onDown: () => f.set(p, c.value ?? 1), onUp: () => f.set(p, 0) };
      }
      case 'subMenu': {
        const menu = c.menu;
        if (!menu) return null;
        return {
          ...base,
          onClick: () => {
            if (c.parameter) f.set(c.parameter, c.value ?? 1);
            stack.push({ title: c.name, items: () => controlItems(menu), control: c });
            render();
          },
        };
      }
      case 'radialPuppet':
        if (!sub.length) return null;
        return {
          ...base,
          detail: () => `${Math.round(f.get(sub[0]) * 100)}%`,
          onClick: () => { if (c.parameter) f.set(c.parameter, c.value ?? 1); mode = { kind: 'dial', control: c }; render(); },
        };
      case 'twoAxisPuppet':
      case 'fourAxisPuppet':
        if (!sub.length) return null;
        return {
          ...base,
          onClick: () => {
            if (c.parameter) f.set(c.parameter, c.value ?? 1);
            mode = { kind: 'stick', control: c, four: c.type === 'fourAxisPuppet' };
            render();
          },
        };
      default:
        return null;
    }
  }

  function appItems(): Item[] {
    const panel = (id: string) => () => { close(); app.togglePanel(id); };
    return [
      // The bottom toolbar (and its move handle) is hidden in transparent mode; the window moves from here.
      { label: t('radial.moveWindow'), iconName: 'move', onClick: () => { const { x, y } = at; close(); app.startWindowMove(x, y); } },
      { label: t('radial.transparent'), iconName: 'transparent', active: () => app.transparent, onClick: () => { app.setTransparent(!app.transparent); render(); } },
      {
        label: t('tb.lock'), iconName: layoutSettings.locked ? 'lock' : 'unlock', active: () => layoutSettings.locked,
        onClick: () => { app.setLayoutLocked(!layoutSettings.locked); render(); },
      },
      { label: t('anim.faceFront'), iconName: 'user', onClick: () => { app.faceFront(); } },
      { label: t('params.vrcTitle'), iconName: 'sliders', onClick: panel('params') },
      { label: t('tb.animation'), iconName: 'film', onClick: panel('animation') },
      { label: t('set.layout'), iconName: 'resize', onClick: panel('layout') },
      { label: t('tb.settings'), iconName: 'settings', onClick: panel('settings') },
      // Quits directly, also from a transparent background (no need to turn it off and close the window).
      { label: t('radial.quit'), iconName: 'power', danger: true, onClick: () => { close(); vav.quit(); } },
    ];
  }

  function rootItems(): Item[] {
    const menu = fx()?.meta.menu;
    const items = menu?.controls?.length ? controlItems(menu) : [];
    const appEntry: Item = {
      label: t('radial.app'), iconName: 'settings',
      onClick: () => { stack.push({ title: t('radial.app'), items: appItems }); render(); },
    };
    // Without an avatar menu the app actions are the whole menu.
    return items.length ? [...items, appEntry] : appItems();
  }

  // -------------------------------------------------------------------------
  // Rendering

  function iconNode(item: Item, px: number) {
    if (item.iconSrc) return h('img', { class: 'radial-icon', src: item.iconSrc, alt: '', style: { width: `${px}px`, height: `${px}px` } });
    if (item.iconName) {
      const s = icon(item.iconName, px);
      s.classList.add('radial-icon');
      return s;
    }
    return null;
  }

  function setCenter(label: string, back: boolean, detail = '') {
    const parts: Node[] = [icon(back ? 'back' : 'close', 16), h('span', { class: 'radial-center-label' }, label)];
    if (detail) parts.push(h('span', { class: 'radial-center-detail' }, detail));
    center.replaceChildren(...parts);
    center.title = back ? t('radial.back') : t('radial.close');
  }

  function clearDrawing() {
    for (const n of [...el.children]) if (n !== center) n.remove();
  }

  function render() {
    clearDrawing();
    const level = stack[stack.length - 1];
    if (mode.kind === 'dial') return renderDial(mode.control);
    if (mode.kind === 'stick') return renderStick(mode.control, mode.four);
    const items = level.items();
    const c = size / 2;
    const ring = svg('svg', { class: 'radial-ring', width: size, height: size, viewBox: `0 0 ${size} ${size}` });
    const labels = h('div', { class: 'radial-labels' });
    const n = Math.max(1, items.length);
    const gap = items.length > 1 ? 0.03 : 0.02;
    const step = (Math.PI * 2) / n;
    items.forEach((item, i) => {
      const a0 = i * step - step / 2 + gap / 2;
      const a1 = a0 + step - gap;
      const path = svg('path', { d: sector(c, inner + 4, outer, a0, a1), class: `radial-slice${item.active?.() ? ' on' : ''}${item.danger ? ' danger' : ''}` });
      path.addEventListener('pointerenter', () => { hoverLabel = item.label; setCenter(item.label, stack.length > 1, item.detail?.()); });
      path.addEventListener('pointerleave', () => { hoverLabel = ''; setCenter(level.title, stack.length > 1); });
      path.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        if (e.button !== 0) return;
        if (item.onDown) { held = item; item.onDown(); path.classList.add('on'); }
      });
      path.addEventListener('click', (e) => {
        e.stopPropagation();
        if (item.onClick) item.onClick();
        if (!item.onDown && mode.kind === 'ring' && stack[stack.length - 1] === level) refreshSlices();
        app.markActive();
      });
      ring.appendChild(path);
      // Icon + label at the slice centre
      const mid = (a0 + a1) / 2;
      const rm = (inner + outer) / 2 + 2;
      const x = c + rm * Math.sin(mid);
      const y = c - rm * Math.cos(mid);
      const arc = Math.max(40, Math.min(96, (a1 - a0) * rm));
      labels.appendChild(h('div', { class: 'radial-item', style: { left: `${x}px`, top: `${y}px`, width: `${arc}px` } },
        iconNode(item, items.length > 10 ? 20 : 26),
        h('span', { class: 'radial-label' }, item.label),
        item.detail ? h('span', { class: 'radial-detail' }, item.detail()) : null));
    });
    if (!items.length) labels.appendChild(h('div', { class: 'radial-empty muted' }, t('params.vrcNoMenu')));
    el.insertBefore(ring, center);
    el.insertBefore(labels, center);
    setCenter(hoverLabel || level.title, stack.length > 1);
  }

  /** Re-colours toggles without rebuilding (keeps the hover state). */
  function refreshSlices() {
    if (el.classList.contains('hidden') || mode.kind !== 'ring') return;
    const level = stack[stack.length - 1];
    const items = level.items();
    const paths = [...el.querySelectorAll('.radial-slice')];
    if (paths.length !== items.length) { render(); return; }
    paths.forEach((p, i) => p.classList.toggle('on', !!items[i].active?.()));
    const details = [...el.querySelectorAll('.radial-item')];
    details.forEach((d, i) => {
      const text = items[i].detail?.();
      const span = d.querySelector('.radial-detail');
      if (span && text !== undefined) span.textContent = text;
    });
  }

  // Radial puppet: drag around the ring; 0 % at the top, clockwise.
  function renderDial(control: VrcControl) {
    const f = fx();
    const param = (control.subParameters || [])[0];
    if (!f || !param) { mode = { kind: 'ring' }; render(); return; }
    const c = size / 2;
    const ring = svg('svg', { class: 'radial-ring dial', width: size, height: size, viewBox: `0 0 ${size} ${size}` });
    const track = svg('path', { d: sector(c, inner + 4, outer, 0, Math.PI * 2 - 0.001), class: 'radial-track' });
    const fill = svg('path', { class: 'radial-fill' });
    const knob = svg('circle', { r: 9, class: 'radial-knob' });
    ring.append(track, fill, knob);
    el.insertBefore(ring, center);
    let value = f.get(param);
    const draw = () => {
      const a = Math.max(0.0001, Math.min(1, value)) * Math.PI * 2;
      fill.setAttribute('d', value > 0.001 ? sector(c, inner + 4, outer, 0, Math.min(a, Math.PI * 2 - 0.001)) : '');
      const rk = (inner + outer) / 2 + 2;
      knob.setAttribute('cx', String(c + rk * Math.sin(a)));
      knob.setAttribute('cy', String(c - rk * Math.cos(a)));
      setCenter(control.name, true, `${Math.round(value * 100)}%`);
    };
    const angleAt = (e: PointerEvent) => {
      const b = el.getBoundingClientRect();
      const dx = e.clientX - (b.left + c), dy = e.clientY - (b.top + c);
      let a = Math.atan2(dx, -dy);
      if (a < 0) a += Math.PI * 2;
      return a / (Math.PI * 2);
    };
    let dragging = false;
    ring.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      dragging = true;
      capture(ring, e);
      value = angleAt(e);
      f.set(param, value);
      draw();
    });
    ring.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      let v = angleAt(e);
      // No jump across the top: stay at 0 / 100 % until the pointer comes back.
      if (value > 0.75 && v < 0.25) v = 1;
      else if (value < 0.25 && v > 0.75) v = 0;
      value = v;
      f.set(param, value);
      draw();
      app.markActive();
    });
    ring.addEventListener('pointerup', (e) => { dragging = false; release(ring, e); });
    draw();
  }

  // Two / four axis puppet: a stick that springs back to the centre (as in VRChat).
  function renderStick(control: VrcControl, four: boolean) {
    const f = fx();
    const params = (control.subParameters || []).slice(0, four ? 4 : 2);
    if (!f || !params.length) { mode = { kind: 'ring' }; render(); return; }
    const c = size / 2;
    const reach = outer - 22;
    const ring = svg('svg', { class: 'radial-ring stick', width: size, height: size, viewBox: `0 0 ${size} ${size}` });
    ring.append(
      svg('circle', { cx: c, cy: c, r: outer, class: 'radial-pad' }),
      svg('line', { x1: c - reach, y1: c, x2: c + reach, y2: c, class: 'radial-axis' }),
      svg('line', { x1: c, y1: c - reach, x2: c, y2: c + reach, class: 'radial-axis' }),
    );
    const puck = svg('circle', { cx: c, cy: c, r: 16, class: 'radial-knob' });
    ring.appendChild(puck);
    el.insertBefore(ring, center);
    // Axis labels: up, right, down, left
    const names = control.labels || [];
    const spots: [number, number][] = [[c, c - outer + 12], [c + outer - 14, c], [c, c + outer - 12], [c - outer + 14, c]];
    const labels = h('div', { class: 'radial-labels' });
    spots.forEach(([x, y], i) => { if (names[i]) labels.appendChild(h('div', { class: 'radial-axis-label', style: { left: `${x}px`, top: `${y}px` } }, names[i])); });
    el.insertBefore(labels, center);
    const apply = (x: number, y: number) => {
      if (four) {
        const v = [Math.max(0, y), Math.max(0, x), Math.max(0, -y), Math.max(0, -x)];
        params.forEach((p, i) => f.set(p, v[i]));
      } else {
        f.set(params[0], x);
        if (params[1]) f.set(params[1], y);
      }
      puck.setAttribute('cx', String(c + x * reach));
      puck.setAttribute('cy', String(c - y * reach));
      app.markActive();
    };
    let dragging = false;
    const move = (e: PointerEvent) => {
      const b = el.getBoundingClientRect();
      let x = (e.clientX - (b.left + c)) / reach;
      let y = -(e.clientY - (b.top + c)) / reach;
      const len = Math.hypot(x, y);
      if (len > 1) { x /= len; y /= len; }
      apply(x, y);
    };
    ring.addEventListener('pointerdown', (e) => { e.stopPropagation(); dragging = true; capture(ring, e); move(e); });
    ring.addEventListener('pointermove', (e) => { if (dragging) move(e); });
    ring.addEventListener('pointerup', (e) => { dragging = false; release(ring, e); apply(0, 0); });
    setCenter(control.name, true);
  }

  // -------------------------------------------------------------------------
  // Open / close / back

  function leaveMode() {
    const f = fx();
    if (mode.kind !== 'ring' && mode.control.parameter && f) f.set(mode.control.parameter, 0);
    mode = { kind: 'ring' };
  }

  function back() {
    if (mode.kind !== 'ring') { leaveMode(); render(); return; }
    if (stack.length <= 1) { close(); return; }
    const top = stack.pop();
    const f = fx();
    if (top?.control?.parameter && f) f.set(top.control.parameter, 0);
    hoverLabel = '';
    render();
  }

  center.addEventListener('pointerdown', (e) => e.stopPropagation());
  center.addEventListener('click', (e) => { e.stopPropagation(); back(); app.markActive(); });
  // Buttons act while held: release anywhere.
  window.addEventListener('pointerup', () => {
    if (!held) return;
    held.onUp?.();
    held = null;
    refreshSlices();
  });
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); back(); });

  function open(x: number, y: number) {
    const w = window.innerWidth, hgt = window.innerHeight;
    // Fit the ring into small (transparent) windows.
    outer = Math.max(80, Math.min(140, Math.min(w, hgt) / 2 - 12));
    inner = Math.round(outer * 0.33);
    size = outer * 2 + 4;
    const cx = Math.min(Math.max(x, size / 2 + 4), w - size / 2 - 4);
    const cy = Math.min(Math.max(y, size / 2 + 4), hgt - size / 2 - 4);
    at.x = cx;
    at.y = cy;
    Object.assign(el.style, { left: `${cx - size / 2}px`, top: `${cy - size / 2}px`, width: `${size}px`, height: `${size}px` });
    Object.assign(center.style, { width: `${inner * 2}px`, height: `${inner * 2}px` });
    if (el.classList.contains('hidden')) {
      stack.length = 0;
      mode = { kind: 'ring' };
      stack.push({ title: fx()?.meta.menu ? t('params.vrcRoot') : t('radial.app'), items: rootItems });
    }
    hoverLabel = '';
    el.classList.remove('hidden');
    render();
    app.markActive();
  }

  function close() {
    if (el.classList.contains('hidden')) return;
    leaveMode();
    const f = fx();
    // Sub menus with a parameter keep it set only while open (VRChat semantics).
    while (stack.length > 1) {
      const top = stack.pop();
      if (top?.control?.parameter && f) f.set(top.control.parameter, 0);
    }
    if (held) { held.onUp?.(); held = null; }
    el.classList.add('hidden');
    clearDrawing();
    app.markActive();
  }

  return {
    el,
    open,
    close,
    isOpen: () => !el.classList.contains('hidden'),
    /** Parameters changed elsewhere (drivers, the menu panel): update lit toggles / values. */
    refresh: refreshSlices,
  };
}
