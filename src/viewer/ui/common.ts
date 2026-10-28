import { h, icon, makeDraggable } from '../../shared/dom';

/** Floating panel with a draggable header and a close button. */
export function panelShell(title: string, onClose: () => void, cls = '') {
  const titleEl = h('span', { class: 'panel-title' }, title);
  const header = h('div', { class: 'panel-header' }, titleEl, h('button', { class: 'icon-btn', title: 'Close', onclick: onClose }, icon('close', 16)));
  const body = h('div', { class: 'panel-body' });
  const el = h('div', { class: `floating ${cls}` }, header, body);
  makeDraggable(el, header);
  return { el, header, body, setTitle(s: string) { titleEl.textContent = s; } };
}

export function section(title: string, ...children: (Node | null | false)[]) {
  return h('div', { class: 'section' }, h('div', { class: 'section-title' }, title), ...children.filter(Boolean) as Node[]);
}

export function button(label: string, onclick: () => void, cls = '') {
  return h('button', { class: `btn ${cls}`, onclick }, label) as HTMLButtonElement;
}
