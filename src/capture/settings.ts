import { persisted } from '../shared/store';

export type ExprFormat = 'vrm' | 'ps' | 'vrcft';

export const cap = persisted('capture.settings', {
  language: 'auto',
  camera: '' as string, // deviceId, or 'none' for iFacialMocap only
  resolution: '1280x720',
  fps: 30,
  model: 'lite' as 'lite' | 'full',
  hands: true,
  mirror: true,
  landmarks: true,
  ifmIp: '',
  ifmUse: false,
  countdown: 3,
  upper: { stability: 0.5, responsiveness: 0.5, amount: 1 },
  arm: { stability: 0.5, responsiveness: 0.5, amount: 1 },
  hand: { depth: 0 },
  eye: { amount: 1, vertical: 0, close: 0.5, open: 0.5 },
  parts: { face: true, head: true, arms: true, upper: true, lower: false },
  lipsync: false,
  mic: '' as string,
  destIp: '127.0.0.1',
  vmcPort: 39539,
  oscPort: 9000,
  format: 'vrm' as ExprFormat,
  vrchatOsc: false,
  vrchatIp: '127.0.0.1',
});
