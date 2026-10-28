// Info overlay (I key): FPS, system and avatar information.
import type { App } from '../app';
import { h, clear } from '../../shared/dom';
import { t } from '../../shared/i18n';
import { general } from '../settings';

export function createInfoOverlay(app: App) {
  const el = h('div', { class: 'info-overlay hidden' });
  let gpu = '';

  function line(k: string, v: string | number) {
    return h('div', { class: 'info-line' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, String(v)));
  }

  function refresh() {
    const show = general.infoOverlay && app.view === 'avatar';
    el.classList.toggle('hidden', !show);
    if (!show) return;
    if (!gpu) {
      const gl = app.stage.renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      gpu = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
    }
    clear(el);
    const s = app.sysInfo;
    const r = app.stage.renderer.info;
    el.append(
      h('div', { class: 'info-fps' }, `${app.fps.toFixed(0)} FPS`),
      h('div', { class: 'info-head' }, t('info.system')),
      line('OS', s ? `${s.os} (${s.arch})` : ''),
      line('CPU', s ? `${s.cpu} × ${s.cores}` : ''),
      line('Memory', s ? `${(s.memory / 1024 ** 3).toFixed(0)} GB` : ''),
      line('GPU', gpu),
      line('Draw calls', r.render.calls),
      line('App', s ? `v${s.appVersion} · Electron ${s.electron}` : ''),
    );
    const a = app.avatar;
    if (a) {
      const i = a.info;
      el.append(
        h('div', { class: 'info-head' }, t('info.avatar')),
        line('Name', i.title),
        i.author ? line('Author', i.author) : '',
        line('Format', i.format),
        line('Meshes', i.meshes),
        line('Triangles', i.triangles.toLocaleString()),
        line('Materials', i.materials),
        line('Textures', i.textures),
        line('Bones', `${i.bones} (humanoid ${i.humanBones})`),
        line('Blendshapes', i.morphs),
        line('Expressions', i.expressions),
        line('Spring joints', i.springJoints),
      );
      const warns = [...a.warnings, ...((app as any).profileMissing || []).map((m: string) => `profile: ${m}`), ...app.profileErrors.map((e) => `${e.file}: ${e.message}`)];
      if (warns.length) {
        el.append(h('div', { class: 'info-head warn' }, t('info.warnings')));
        for (const w of warns.slice(0, 12)) el.append(h('div', { class: 'info-warn' }, w));
      }
    }
    el.append(h('div', { class: 'muted small' }, t('info.close')));
  }
  return { el, refresh };
}
