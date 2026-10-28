// Streaming mode: VMC / VRChat OSC input, broadcast camera, smoothing, avatar profile, Syphon output.
import type { App } from '../app';
import { h, clear, slider, toggle, select, numberInput, textInput, toast } from '../../shared/dom';
import { t } from '../../shared/i18n';
import { streaming as settings } from '../settings';
import { panelShell, section, button } from './common';
import type { ViewerBridge } from '../../shared/bridge';

const vav = (window as any).vav as ViewerBridge;

const RESOLUTIONS = ['window', '1280x720', '1920x1080', '2560x1440', '3840x2160', '1080x1920', '1080x1080'];

export function createStreamingPanel(app: App) {
  const shell = panelShell(t('tb.streaming'), () => app.togglePanel('streaming'), 'streaming-panel');
  const s = app.streaming;
  const restartIfRunning = () => { if (s.running) s.start(); };

  // --- Motion input
  const conn = select(t('st.connection'), [
    { value: 'vmc', label: t('st.conn.vmc') },
    { value: 'osc', label: t('st.conn.osc') },
  ], settings.connection, (v) => { settings.connection = v as any; settings.save(); restartIfRunning(); refresh(); });
  const vmcPort = numberInput(t('st.vmcPort'), settings.vmcPort, (v) => { settings.vmcPort = v; settings.save(); restartIfRunning(); }, { min: 1, max: 65535, width: '84px' });
  const oscPort = numberInput(t('st.oscPort'), settings.oscPort, (v) => { settings.oscPort = v; settings.save(); restartIfRunning(); }, { min: 1, max: 65535, width: '84px' });
  const startBtn = button(t('st.start'), async () => {
    if (s.running) await s.stop(); else await s.start();
    refresh();
    app.rerenderUI();
  }, 'primary');
  const status = h('div', { class: 'status-lines' });

  // --- Camera
  const ik = toggle(t('st.ik'), settings.ik, (v) => { settings.ik = v; settings.save(); });
  const fov = slider({
    label: t('st.fov'), min: 10, max: 90, step: 1, value: settings.fov, format: (v) => `${v.toFixed(0)}°`,
    onInput: (v) => { settings.fov = v; settings.save(); app.stage.rig.setFov(v); app.markActive(); },
    onReset: () => { settings.fov = 30; settings.save(); app.stage.rig.setFov(30); app.markActive(); return 30; },
  });
  const zoom = slider({
    label: t('st.zoomEmphasis'), min: 0, max: 1, step: 0.01, value: settings.zoomEmphasis,
    onInput: (v) => { settings.zoomEmphasis = v; settings.save(); },
    onReset: () => { settings.zoomEmphasis = 0; settings.save(); return 0; },
  });
  const camButtons = h('div', { class: 'button-row' },
    button(t('st.faceFront'), () => app.faceFront(), 'small'),
    // Same saves as Settings → Position / Scale / Rotation (per avatar, includes the field of view).
    button(t('st.saveCamera'), () => app.saveLayout(), 'small'),
    button(t('st.restoreCamera'), () => { if (app.restoreLayout()) fov.set(settings.fov); }, 'small'),
  );

  // --- Smoothing
  const smoothKeys = ['head', 'body', 'arms', 'gaze', 'blink', 'brow', 'mouth'];
  const smoothSliders = smoothKeys.map((k) => slider({
    label: t(`st.sm.${k}`), min: 0, max: 1, step: 0.01, value: settings.smoothing[k] ?? 0.3,
    onInput: (v) => { settings.smoothing[k] = v; settings.save(); },
  }));

  // --- Avatar profile
  const profileSel = select(t('st.profile'), [{ value: '', label: t('st.profile.none') }], settings.profileFile, (v) => {
    settings.profileFile = v;
    settings.save();
    app.applyProfile();
    refresh();
  });
  const profileNote = h('div', { class: 'muted small' });
  const profileButtons = h('div', { class: 'button-row' },
    button(t('st.profile.openFolder'), () => vav.profiles.openFolder(), 'small'),
    button(t('st.profile.reload'), async () => { await app.reloadProfiles(); refresh(); }, 'small'),
  );

  // --- Syphon
  const syName = textInput(t('st.syphon.name'), settings.syphonName, (v) => {
    settings.syphonName = v || 'VRC Avatar Tools';
    settings.save();
    if (app.syphon.running) vav.syphon.start(settings.syphonName);
    refresh();
  });
  const syRes = select(t('st.syphon.resolution'), RESOLUTIONS.map((r) => ({ value: r, label: r === 'window' ? t('st.syphon.res.window') : r.replace('x', ' × ') })), settings.syphonResolution, (v) => { settings.syphonResolution = v; settings.save(); });
  const syFps = select(t('st.syphon.fps'), [{ value: '30', label: '30' }, { value: '60', label: '60' }], String(settings.syphonFps), (v) => { settings.syphonFps = parseInt(v, 10); settings.save(); });
  const syBtn = button(t('st.syphon.start'), async () => {
    if (app.syphon.running) await app.syphon.stop();
    else if (await app.syphon.start()) toast(t('toast.syphonStarted'));
    else toast(t('st.syphon.unavailable'), 5000);
    refresh();
    app.rerenderUI();
  }, 'primary');
  const syStatus = h('div', { class: 'status-lines' });
  const syHint = h('div', { class: 'muted small hint' });
  app.syphon.onStatus = () => refresh();

  shell.body.append(
    section(t('st.motion'), conn.el, vmcPort.el, oscPort.el, h('div', { class: 'button-row' }, startBtn, button(t('set.openCapture'), () => vav.openCapture(), 'small ghost')), status),
    h('div', { class: 'menu-buttons' }, button(t('st.faceTracking'), () => app.togglePanel('face'))),
    section(t('st.camera'), ik.el, fov.el, zoom.el, camButtons),
    section(t('st.smoothing'), ...smoothSliders.map((x) => x.el), h('div', { class: 'muted small' }, t('st.smoothHint'))),
    section(t('st.profile'), profileSel.el, profileButtons, profileNote),
    vav.platform === 'darwin'
      ? section(t('st.syphon'), syName.el, syRes.el, syFps.el, syBtn, syStatus, syHint)
      : section(t('st.obsWindows'), h('div', { class: 'muted small hint' }, t('st.obsWindowsHint'))),
  );

  s.onStatus = () => { if (!shell.el.classList.contains('hidden')) updateStatus(); };

  function statusText(kind: 'vmc' | 'osc') {
    const st = kind === 'vmc' ? s.vmcStatus : s.oscStatus;
    const err = kind === 'vmc' ? s.vmcError : s.oscError;
    const port = kind === 'vmc' ? settings.vmcPort : settings.oscPort;
    if (err) return h('div', { class: 'status error' }, `${kind.toUpperCase()}: ${t('st.status.portError', { port })} (${err})`);
    const label = st === 'receiving' ? t('st.status.receiving') : st === 'waiting' ? t('st.status.waiting') : t('st.status.stopped');
    const detail = st === 'receiving'
      ? kind === 'vmc'
        ? t('st.recvInfo', { bones: s.bonesCount, blends: s.blendCount, pps: s.vmcPps })
        : t('st.oscInfo', { n: s.oscCount, pps: s.oscPps })
      : '';
    return h('div', { class: `status ${st}` }, h('span', { class: 'dot' }), `${kind === 'vmc' ? 'VMC' : 'VRChat OSC'} :${port} · ${label} `, h('span', { class: 'muted' }, detail));
  }

  function updateStatus() {
    clear(status);
    if (!s.running) { status.appendChild(h('div', { class: 'status stopped' }, h('span', { class: 'dot' }), t('st.status.stopped'))); }
    else {
      if (settings.connection === 'vmc') status.appendChild(statusText('vmc'));
      if (s.needsOsc()) status.appendChild(statusText('osc'));
    }
    startBtn.textContent = s.running ? t('st.stop') : t('st.start');
    startBtn.classList.toggle('danger', s.running);
  }

  function refresh() {
    conn.set(settings.connection);
    vmcPort.el.classList.toggle('hidden', settings.connection !== 'vmc');
    oscPort.el.classList.toggle('hidden', !s.needsOsc());
    ik.set(settings.ik);
    fov.set(settings.fov);
    zoom.set(settings.zoomEmphasis);
    smoothKeys.forEach((k, i) => smoothSliders[i].set(settings.smoothing[k] ?? 0.3));
    profileSel.setOptions([{ value: '', label: t('st.profile.none') }, ...app.profiles.map((p) => ({ value: p.file, label: p.name }))], settings.profileFile);
    if (settings.profileFile && !app.profiles.some((p) => p.file === settings.profileFile)) profileSel.set('');
    const missing: string[] = (app as any).profileMissing || [];
    const warnCount = missing.length + app.profileErrors.length;
    profileNote.textContent = warnCount ? t('st.profile.warnings', { n: warnCount }) : '';
    syBtn.textContent = app.syphon.running ? t('st.syphon.stop') : t('st.syphon.start');
    syBtn.classList.toggle('danger', app.syphon.running);
    clear(syStatus);
    if (app.syphon.running) {
      syStatus.appendChild(h('div', { class: `status ${app.syphon.clients ? 'receiving' : 'waiting'}` }, h('span', { class: 'dot' }),
        app.syphon.clients ? t('st.syphon.clientsYes') : t('st.syphon.clientsNo')));
    } else if (!app.syphon.available) {
      syStatus.appendChild(h('div', { class: 'status error' }, t('st.syphon.unavailable')));
    }
    syHint.textContent = `${t('st.syphon.hint', { name: settings.syphonName })}\n${t('st.syphon.transparentNote')}`;
    updateStatus();
  }

  refresh();
  return { el: shell.el, refresh };
}
