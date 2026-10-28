// Settings menu: lighting, cursor gaze, stand, parameters, idle FPS, keys, transparency, language.
import type { App } from '../app';
import { h, toggle, select, slider, toast } from '../../shared/dom';
import { t, LANGS } from '../../shared/i18n';
import { general, transparentSettings, type LowFpsMode, type ModKey } from '../settings';
import { avatarStates } from '../avatarState';
import { panelShell, section, button } from './common';
import type { ViewerBridge, LoginItemState } from '../../shared/bridge';

const vav = (window as any).vav as ViewerBridge;

export function createSettingsPanel(app: App) {
  const shell = panelShell(t('set.title'), () => app.togglePanel('settings'), 'settings-panel');
  const modOptions = (['alt', 'control', 'shift', 'command'] as ModKey[]).map((k) => ({ value: k, label: t(`key.${k}`) }));

  const cursorGaze = toggle(t('set.cursorGaze'), general.cursorGaze, (v) => {
    general.cursorGaze = v; general.save(); (app as any).updateCursorWanted(); app.markActive();
  });
  const stand = toggle(t('set.stand'), general.stand, (v) => { general.stand = v; general.save(); app.markActive(); });
  const lowFps = select<LowFpsMode>(t('set.lowFps'), [
    { value: 'off', label: t('set.lowFps.off') },
    { value: 'shader', label: t('set.lowFps.shader') },
    { value: 'on', label: t('set.lowFps.on') },
  ], general.lowFps, (v) => { general.lowFps = v; general.save(); app.markActive(); });
  const alwaysKeys = toggle(t('set.alwaysKeys'), general.alwaysKeys, async (v) => {
    const r = await vav.keys.setGlobal(v);
    if (v && !r.ok) {
      alwaysKeys.set(false);
      general.alwaysKeys = false;
      toast(r.reason === 'permission' || r.reason === 'tap' ? t('set.alwaysKeysPermission')
        : r.reason === 'shortcut' ? t('set.alwaysKeysBusy') : 'native module missing', 7000);
    } else {
      general.alwaysKeys = v;
    }
    general.save();
  }, 'Shift + F1~F8 (fn + Shift + F1~F8)');
  const bgInput = h('input', { type: 'color', value: general.background }) as HTMLInputElement;
  bgInput.addEventListener('input', () => { general.background = bgInput.value; general.save(); app.stage.applyBackground(); app.markActive(); });
  const bgRow = h('label', { class: 'row input-row' }, h('span', { class: 'label' }, t('set.background')), bgInput);
  // Windows: a transparent window has no resizable frame, so its size is chosen here.
  const SIZES = ['900x1000', '720x1280', '1080x1080', '1280x720', '1920x1080', '600x800'];
  const winSize = select(t('set.windowSize'), [
    { value: '', label: t('set.windowSize.current') },
    ...SIZES.map((s) => ({ value: s, label: s.replace('x', ' × ') })),
  ], '', (v) => {
    if (!v) return;
    const [w, hgt] = v.split('x').map(Number);
    vav.win.setSize(w, hgt);
    winSize.set('');
  });
  const pixelRatio = select(t('set.pixelRatio'), [
    { value: '1', label: '100%' }, { value: '0.75', label: '75%' }, { value: '0.5', label: '50%' },
  ], String(general.pixelRatio), (v) => { general.pixelRatio = parseFloat(v); general.save(); app.stage.resize(); app.markActive(); });

  const onTop = toggle(t('set.alwaysOnTop'), transparentSettings.alwaysOnTop, (v) => { transparentSettings.alwaysOnTop = v; transparentSettings.save(); app.applyTransparentOptions(); });
  const clickThrough = toggle(t('set.clickThrough'), transparentSettings.clickThrough, (v) => { transparentSettings.clickThrough = v; transparentSettings.save(); app.applyTransparentOptions(); });
  const releaseKey = select<ModKey>(t('set.releaseKey'), modOptions, transparentSettings.releaseKey, (v) => { transparentSettings.releaseKey = v; transparentSettings.save(); });
  const avatarFade = toggle(t('set.avatarFade'), transparentSettings.avatarFade, (v) => { transparentSettings.avatarFade = v; transparentSettings.save(); app.applyTransparentOptions(); }, t('set.avatarFadeNeedsTransparent'));
  const fadeKey = select<ModKey>(t('set.avatarFadeKey'), modOptions, transparentSettings.fadeKey, (v) => { transparentSettings.fadeKey = v; transparentSettings.save(); });
  const fadeOpacity = slider({
    label: t('set.avatarFadeOpacity'), min: 0, max: 0.9, step: 0.05, value: transparentSettings.fadeOpacity, format: (v) => `${Math.round(v * 100)}%`,
    onInput: (v) => { transparentSettings.fadeOpacity = v; transparentSettings.save(); },
  });

  const lang = select(t('set.language'), LANGS.map((l) => ({ value: l.id, label: l.id === 'auto' ? t('set.lang.auto') : l.label })), general.language, (v) => {
    general.language = v;
    general.save();
    vav.setLanguage(v);
    setTimeout(() => location.reload(), 150);
  });
  // Startup: macOS login item + reopen the last avatar / transparent mode.
  const autoLaunch = toggle(t('set.autoLaunch'), false, async (v) => {
    autoLaunch.setDisabled(true);
    const r = await vav.login.set(v);
    showLogin(r);
    if (r.error) toast(`${t('set.autoLaunchFailed')}: ${r.error}`, 7000);
    else if (v && r.status === 'requires-approval') {
      toast(t('set.autoLaunchApprove'), 8000);
      vav.login.openSettings();
    } else toast(t(r.openAtLogin ? 'set.autoLaunchOn' : 'set.autoLaunchOff'));
  }, t('set.autoLaunchHint'));
  const openLast = toggle(t('set.openLast'), general.openLast, (v) => { general.openLast = v; general.save(); }, t('set.openLastHint'));
  const remember = toggle(t('set.rememberState'), avatarStates.enabled, (v) => {
    avatarStates.enabled = v;
    avatarStates.save();
    if (v) app.rememberAvatarState();
  }, t('set.rememberStateHint'));
  const loginNote = h('div', { class: 'muted small login-note' });
  function showLogin(s: LoginItemState) {
    autoLaunch.set(s.openAtLogin);
    autoLaunch.setDisabled(!s.supported);
    loginNote.textContent = !s.supported ? t('set.autoLaunchDev') : s.status === 'requires-approval' ? t('set.autoLaunchApprove') : '';
    loginNote.classList.toggle('hidden', !loginNote.textContent);
  }

  const infoToggle = toggle(t('set.info'), general.infoOverlay, (v) => { general.infoOverlay = v; general.save(); app.rerenderUI(); });
  const paramsBtn = button(t('set.exprParams'), () => app.togglePanel('params'));

  shell.body.append(
    h('div', { class: 'menu-buttons' },
      button(t('set.lighting'), () => app.togglePanel('lighting')),
      button(t('set.layout'), () => app.togglePanel('layout')),
      paramsBtn,
    ),
    cursorGaze.el,
    stand.el,
    lowFps.el,
    alwaysKeys.el,
    bgRow,
    ...(vav.platform === 'win32' ? [winSize.el] : []),
    pixelRatio.el,
    section(t('set.transparentGroup'), onTop.el, clickThrough.el, releaseKey.el, avatarFade.el, fadeKey.el, fadeOpacity.el),
    section(t('set.startupGroup'), autoLaunch.el, loginNote, openLast.el, remember.el),
    lang.el,
    infoToggle.el,
    button(t('set.openCapture'), () => vav.openCapture(), 'ghost'),
  );

  function refresh() {
    cursorGaze.set(general.cursorGaze);
    stand.set(general.stand);
    lowFps.set(general.lowFps);
    alwaysKeys.set(general.alwaysKeys);
    infoToggle.set(general.infoOverlay);
    openLast.set(general.openLast);
    remember.set(avatarStates.enabled);
    // System Settings can change the login item too, so ask every time the menu opens.
    vav.login.get().then(showLogin).catch(() => showLogin({ supported: false, openAtLogin: false, status: 'unsupported' }));
    avatarFade.setDisabled(!app.transparent);
    fadeKey.setDisabled(!app.transparent || !transparentSettings.avatarFade);
    fadeOpacity.setDisabled(!app.transparent || !transparentSettings.avatarFade);
    // Avatars converted from VRChat keep the "FX parameters" naming; VRM gets expressions.
    paramsBtn.textContent = app.avatar?.vrm ? t('set.exprParams') : t('set.fxParams');
  }
  refresh();
  return { el: shell.el, refresh };
}
