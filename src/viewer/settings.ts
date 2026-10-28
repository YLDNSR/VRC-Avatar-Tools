// Persisted viewer settings (survive app restarts).
import { persisted } from '../shared/store';

export type LowFpsMode = 'off' | 'shader' | 'on';
export type ModKey = 'alt' | 'control' | 'shift' | 'command';
export type LightPreset = 'default' | 'left' | 'right' | 'top' | 'front' | 'custom';
export type FaceType = 'vrm' | 'ps' | 'vrcft';

export const general = persisted('settings.general', {
  language: 'auto',
  lowFps: 'off' as LowFpsMode,
  cursorGaze: false,
  stand: true,
  alwaysKeys: false,
  background: '#3a3d46',
  pixelRatio: 1,
  lastFolder: '' as string,
  recent: [] as { path: string; title: string; thumbnail?: string | null }[],
  infoOverlay: false,
  /** On launch, reopen the last avatar (and transparent mode if it was on). */
  openLast: false,
  lastTransparent: false,
});

export const transparentSettings = persisted('settings.transparent', {
  alwaysOnTop: true,
  clickThrough: true,
  releaseKey: 'alt' as ModKey,
  avatarFade: false,
  fadeKey: 'control' as ModKey,
  fadeOpacity: 0.25,
});

export const LIGHT_PRESETS: Record<Exclude<LightPreset, 'custom'>, { azimuth: number; elevation: number }> = {
  default: { azimuth: -25, elevation: 35 },
  left: { azimuth: -70, elevation: 25 },
  right: { azimuth: 70, elevation: 25 },
  top: { azimuth: 0, elevation: 75 },
  front: { azimuth: 0, elevation: 8 },
};

export const LIGHT_DEFAULTS = { azimuth: -25, elevation: 35, brightness: 0.8, temperature: 6500 };

export const lighting = persisted('settings.lighting', {
  preset: 'default' as LightPreset,
  azimuth: LIGHT_DEFAULTS.azimuth,
  elevation: LIGHT_DEFAULTS.elevation,
  brightness: LIGHT_DEFAULTS.brightness,
  temperature: LIGHT_DEFAULTS.temperature,
  custom: null as null | { azimuth: number; elevation: number; brightness: number; temperature: number },
  lock: 'world' as 'world' | 'avatar',
  marker: false,
});

export interface AnimItem {
  path: string;
  name: string;
}

export const animation = persisted('settings.animation', {
  mode: 'single' as 'single' | 'playlist' | 'sets',
  standSize: 1,
  yOffset: 0,
  repeat: 'all' as 'off' | 'one' | 'all',
  speed: 1,
  playlist: [] as AnimItem[],
  sets: [] as { name: string; items: AnimItem[] }[],
  activeSet: 0,
  lastSingle: null as AnimItem | null,
});

export const streaming = persisted('settings.streaming', {
  connection: 'vmc' as 'vmc' | 'osc',
  vmcPort: 39539,
  oscPort: 9000,
  faceType: 'vrm' as FaceType,
  ik: false,
  fov: 30,
  zoomEmphasis: 0,
  smoothing: { head: 0.35, body: 0.35, arms: 0.3, gaze: 0.25, blink: 0.1, brow: 0.3, mouth: 0.15 } as Record<string, number>,
  strength: { blink: 1, gaze: 1, brow: 1, mouth: 1, emotion: 1, other: 1 } as Record<string, number>,
  profileFile: '' as string,
  savedCamera: null as any,
  syphonName: 'VRC Avatar Tools',
  syphonResolution: '1920x1080',
  syphonFps: 60,
});
