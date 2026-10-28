// Small DOM helpers and form controls shared by both windows.

type Child = Node | string | number | null | undefined | false;
type Props = Record<string, any>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') (el as any)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

function append(el: HTMLElement, children: (Child | Child[])[]) {
  for (const c of children) {
    if (Array.isArray(c)) append(el, c);
    else if (c == null || c === false) continue;
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function clear(el: HTMLElement) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

const ICONS: Record<string, string> = {
  back: '<path d="M15 18l-6-6 6-6"/>',
  open: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
  play: '<path d="M7 5l12 7-12 7z" fill="currentColor"/>',
  pause: '<path d="M7 5h3v14H7zM14 5h3v14h-3z" fill="currentColor"/>',
  stop: '<rect x="6" y="6" width="12" height="12" fill="currentColor"/>',
  prev: '<path d="M18 6l-8 6 8 6zM6 6v12" />',
  next: '<path d="M6 6l8 6-8 6zM18 6v12" />',
  repeat: '<path d="M4 12V9a3 3 0 0 1 3-3h11"/><path d="M15 3l3 3-3 3"/><path d="M20 12v3a3 3 0 0 1-3 3H6"/><path d="M9 21l-3-3 3-3"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
  transparent: '<rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="3 3"/><circle cx="12" cy="10" r="3"/><path d="M7 19c1-3 3-4 5-4s4 1 5 4"/>',
  stream: '<circle cx="12" cy="12" r="2"/><path d="M8.5 15.5a5 5 0 0 1 0-7M15.5 8.5a5 5 0 0 1 0 7M5.6 18.4a9 9 0 0 1 0-12.8M18.4 5.6a9 9 0 0 1 0 12.8"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  move: '<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  light: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  face: '<circle cx="12" cy="12" r="9"/><circle cx="9" cy="10" r="1" fill="currentColor"/><circle cx="15" cy="10" r="1" fill="currentColor"/><path d="M8.5 15c1 1.2 2.2 1.8 3.5 1.8s2.5-.6 3.5-1.8"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>',
  power: '<path d="M12 3v8"/><path d="M6.3 6.6a8 8 0 1 0 11.4 0"/>',
  resize: '<path d="M4 9V4h5M20 15v5h-5M4 4l6 6M20 20l-6-6"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.6-1.8"/>',
};

export function icon(name: string, size = 20): SVGElement {
  const wrap = document.createElement('span');
  wrap.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  return wrap.firstChild as SVGElement;
}

// --- Controls --------------------------------------------------------------

export interface SliderOpts {
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  format?: (v: number) => string;
  onInput: (v: number) => void;
  onReset?: () => number;
}

export function slider(o: SliderOpts) {
  const out = h('span', { class: 'value' });
  const input = h('input', { type: 'range', min: String(o.min), max: String(o.max), step: String(o.step ?? 0.01) }) as HTMLInputElement;
  input.value = String(o.value);
  const fmt = o.format || ((v: number) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2)));
  out.textContent = fmt(o.value);
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    out.textContent = fmt(v);
    o.onInput(v);
  });
  const reset = o.onReset
    ? h('button', {
        class: 'icon-btn small', title: 'Reset', onclick: () => {
          const v = o.onReset!();
          input.value = String(v);
          out.textContent = fmt(v);
        },
      }, '↺')
    : null;
  const row = h('label', { class: 'row slider-row' }, h('span', { class: 'label' }, o.label), input, out, reset);
  return {
    el: row,
    input,
    set(v: number) { input.value = String(v); out.textContent = fmt(v); },
    setDisabled(d: boolean) { input.disabled = d; row.classList.toggle('disabled', d); },
  };
}

export function toggle(label: string, value: boolean, onChange: (v: boolean) => void, hint?: string) {
  const input = h('input', { type: 'checkbox' }) as HTMLInputElement;
  input.checked = value;
  input.addEventListener('change', () => onChange(input.checked));
  const row = h('label', { class: 'row toggle-row', title: hint || '' }, h('span', { class: 'label' }, label), h('span', { class: 'switch' }, input, h('span', { class: 'knob' })));
  return {
    el: row,
    input,
    set(v: boolean) { input.checked = v; },
    setDisabled(d: boolean) { input.disabled = d; row.classList.toggle('disabled', d); },
  };
}

export function select<T extends string>(label: string, options: { value: T; label: string }[], value: T, onChange: (v: T) => void) {
  const sel = h('select') as HTMLSelectElement;
  const fill = (opts: { value: T; label: string }[]) => {
    clear(sel);
    for (const o of opts) sel.appendChild(h('option', { value: o.value }, o.label));
  };
  fill(options);
  sel.value = value;
  sel.addEventListener('change', () => onChange(sel.value as T));
  const row = h('label', { class: 'row select-row' }, label ? h('span', { class: 'label' }, label) : null, sel);
  return {
    el: row,
    select: sel,
    set(v: T) { sel.value = v; },
    setOptions(opts: { value: T; label: string }[], v?: T) { fill(opts); if (v !== undefined) sel.value = v; },
    setDisabled(d: boolean) { sel.disabled = d; row.classList.toggle('disabled', d); },
  };
}

export function segmented<T extends string>(options: { value: T; label: string }[], value: T, onChange: (v: T) => void) {
  const el = h('div', { class: 'segmented' });
  const buttons = new Map<T, HTMLButtonElement>();
  for (const o of options) {
    const b = h('button', { class: 'seg', onclick: () => { set(o.value); onChange(o.value); } }, o.label) as HTMLButtonElement;
    buttons.set(o.value, b);
    el.appendChild(b);
  }
  function set(v: T) {
    for (const [k, b] of buttons) b.classList.toggle('active', k === v);
  }
  set(value);
  return { el, set };
}

export function numberInput(label: string, value: number, onChange: (v: number) => void, opts: { min?: number; max?: number; width?: string } = {}) {
  const input = h('input', { type: 'number', min: opts.min != null ? String(opts.min) : undefined, max: opts.max != null ? String(opts.max) : undefined }) as HTMLInputElement;
  input.value = String(value);
  if (opts.width) input.style.width = opts.width;
  input.addEventListener('change', () => {
    let v = parseInt(input.value, 10);
    if (!Number.isFinite(v)) v = value;
    if (opts.min != null) v = Math.max(opts.min, v);
    if (opts.max != null) v = Math.min(opts.max, v);
    input.value = String(v);
    onChange(v);
  });
  const row = h('label', { class: 'row input-row' }, h('span', { class: 'label' }, label), input);
  return { el: row, input, set(v: number) { input.value = String(v); }, setDisabled(d: boolean) { input.disabled = d; } };
}

export function textInput(label: string, value: string, onChange: (v: string) => void, placeholder = '') {
  const input = h('input', { type: 'text', placeholder, spellcheck: false }) as HTMLInputElement;
  input.value = value;
  input.addEventListener('change', () => onChange(input.value.trim()));
  const row = h('label', { class: 'row input-row' }, h('span', { class: 'label' }, label), input);
  return { el: row, input, set(v: string) { input.value = v; }, setDisabled(d: boolean) { input.disabled = d; } };
}

let toastTimer = 0;
export function toast(message: string, ms = 2600) {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast' });
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove('show'), ms);
}

/** Makes a floating panel draggable by its header. */
export function makeDraggable(panel: HTMLElement, handle: HTMLElement) {
  let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
  handle.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('button, input, select')) return;
    dragging = true;
    const r = panel.getBoundingClientRect();
    sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const x = Math.max(0, Math.min(window.innerWidth - 60, ox + e.clientX - sx));
    const y = Math.max(0, Math.min(window.innerHeight - 40, oy + e.clientY - sy));
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  });
  handle.addEventListener('pointerup', () => { dragging = false; });
}
