// Facial expression vocabularies: ARKit (Perfect Sync), VRM presets, VRCFaceTracking v2.

export const ARKIT_NAMES = [
  'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight',
  'cheekPuff', 'cheekSquintLeft', 'cheekSquintRight',
  'eyeBlinkLeft', 'eyeBlinkRight', 'eyeLookDownLeft', 'eyeLookDownRight', 'eyeLookInLeft', 'eyeLookInRight',
  'eyeLookOutLeft', 'eyeLookOutRight', 'eyeLookUpLeft', 'eyeLookUpRight', 'eyeSquintLeft', 'eyeSquintRight',
  'eyeWideLeft', 'eyeWideRight',
  'jawForward', 'jawLeft', 'jawOpen', 'jawRight',
  'mouthClose', 'mouthDimpleLeft', 'mouthDimpleRight', 'mouthFrownLeft', 'mouthFrownRight', 'mouthFunnel',
  'mouthLeft', 'mouthLowerDownLeft', 'mouthLowerDownRight', 'mouthPressLeft', 'mouthPressRight', 'mouthPucker',
  'mouthRight', 'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper', 'mouthSmileLeft',
  'mouthSmileRight', 'mouthStretchLeft', 'mouthStretchRight', 'mouthUpperUpLeft', 'mouthUpperUpRight',
  'noseSneerLeft', 'noseSneerRight', 'tongueOut',
] as const;

/** VMC / VRM 0.x preset names → VRM 1.0 expression names used by three-vrm. */
export const VRM0_TO_VRM1: Record<string, string> = {
  joy: 'happy', angry: 'angry', sorrow: 'sad', fun: 'relaxed', surprised: 'surprised', neutral: 'neutral',
  a: 'aa', i: 'ih', u: 'ou', e: 'ee', o: 'oh',
  blink: 'blink', blink_l: 'blinkLeft', blink_r: 'blinkRight',
  lookup: 'lookUp', lookdown: 'lookDown', lookleft: 'lookLeft', lookright: 'lookRight',
  // VRM 1.0 names arriving directly
  happy: 'happy', sad: 'sad', relaxed: 'relaxed', aa: 'aa', ih: 'ih', ou: 'ou', ee: 'ee', oh: 'oh',
  blinkleft: 'blinkLeft', blinkright: 'blinkRight',
};

/** Fallback blendshape names often found on VRChat / MMD style avatars. */
export const VRC_FALLBACK_MORPHS: Record<string, string[]> = {
  aa: ['vrc.v_aa', 'v_aa', 'あ', 'mouth_a', 'a'],
  ih: ['vrc.v_ih', 'v_ih', 'い', 'mouth_i', 'i'],
  ou: ['vrc.v_ou', 'v_ou', 'う', 'mouth_u', 'u'],
  ee: ['vrc.v_e', 'v_e', 'え', 'mouth_e', 'e'],
  oh: ['vrc.v_oh', 'v_oh', 'お', 'mouth_o', 'o'],
  blink: ['vrc.blink', 'blink', 'まばたき', 'eye_close', 'blink_both', 'eyes_closed'],
  blinkLeft: ['vrc.blink_left', 'blink_l', 'ウィンク', 'eye_close_l', 'eyeblinkleft', 'wink_l'],
  blinkRight: ['vrc.blink_right', 'blink_r', 'ウィンク右', 'eye_close_r', 'eyeblinkright', 'wink_r'],
  happy: ['笑い', 'smile', 'joy', 'happy'],
  angry: ['怒り', 'angry'],
  sad: ['困る', 'sorrow', 'sad'],
  relaxed: ['なごみ', 'fun', 'relaxed'],
  surprised: ['びっくり', 'surprised', 'surprise'],
};

/** Normalizes blendshape names so "EyeBlink_L", "eyeBlinkLeft", "eye_blink_l" all compare equal. */
export function normalizeShapeName(name: string): string {
  let n = name.toLowerCase();
  const dot = n.lastIndexOf('.');
  if (dot >= 0 && dot < n.length - 1 && !n.startsWith('vrc.')) n = n.slice(dot + 1);
  n = n.replace(/[\s_\-.]/g, '');
  n = n.replace(/left$/, 'l').replace(/right$/, 'r');
  return n;
}

/** Unified Expressions shape names that indicate a VRCFT-ready mesh. */
export const UE_SHAPES = [
  'EyeClosedLeft', 'EyeClosedRight', 'EyeWideLeft', 'EyeWideRight', 'EyeSquintLeft', 'EyeSquintRight',
  'BrowLowererLeft', 'BrowLowererRight', 'BrowInnerUpLeft', 'BrowInnerUpRight', 'BrowOuterUpLeft', 'BrowOuterUpRight',
  'BrowPinchLeft', 'BrowPinchRight', 'JawOpen', 'MouthClosed', 'JawLeft', 'JawRight', 'JawForward',
  'MouthCornerPullLeft', 'MouthCornerPullRight', 'MouthCornerSlantLeft', 'MouthCornerSlantRight',
  'MouthFrownLeft', 'MouthFrownRight', 'MouthStretchLeft', 'MouthStretchRight', 'MouthDimpleLeft', 'MouthDimpleRight',
  'MouthUpperUpLeft', 'MouthUpperUpRight', 'MouthLowerDownLeft', 'MouthLowerDownRight', 'MouthPressLeft', 'MouthPressRight',
  'LipFunnelUpperLeft', 'LipFunnelUpperRight', 'LipFunnelLowerLeft', 'LipFunnelLowerRight',
  'LipPuckerUpperLeft', 'LipPuckerUpperRight', 'LipPuckerLowerLeft', 'LipPuckerLowerRight',
  'LipSuckUpperLeft', 'LipSuckUpperRight', 'LipSuckLowerLeft', 'LipSuckLowerRight',
  'CheekPuffLeft', 'CheekPuffRight', 'CheekSquintLeft', 'CheekSquintRight', 'NoseSneerLeft', 'NoseSneerRight',
  'TongueOut', 'MouthRaiserUpper', 'MouthRaiserLower',
];

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export interface VrcftOutput {
  /** ARKit-named weights (0..1) */
  arkit: Record<string, number>;
  /** Unified Expressions shape weights (0..1) */
  ue: Record<string, number>;
  /** Gaze in normalized -1..1 (x: right+, y: up+) */
  gaze: { leftX: number; leftY: number; rightX: number; rightY: number } | null;
}

/**
 * Converts VRCFaceTracking v2 OSC parameters (names without the "v2/" prefix)
 * into ARKit and Unified Expressions blendshape weights.
 */
export function vrcftToShapes(p: Record<string, number>): VrcftOutput {
  const arkit: Record<string, number> = {};
  const ue: Record<string, number> = {};
  const has = (k: string) => p[k] !== undefined;
  const g = (k: string, def = 0) => (p[k] !== undefined ? p[k] : def);
  const setMax = (rec: Record<string, number>, k: string, v: number) => {
    v = clamp01(v);
    if (rec[k] === undefined || rec[k] < v) rec[k] = v;
  };

  for (const side of ['Left', 'Right'] as const) {
    const lid = has(`EyeLid${side}`) ? p[`EyeLid${side}`] : has('EyeLid') ? p.EyeLid : undefined;
    if (lid !== undefined) {
      const closed = lid < 0.75 ? 1 - lid / 0.75 : 0;
      const wide = lid > 0.75 ? (lid - 0.75) / 0.25 : 0;
      setMax(arkit, `eyeBlink${side}`, closed);
      setMax(arkit, `eyeWide${side}`, wide);
      setMax(ue, `EyeClosed${side}`, closed);
      setMax(ue, `EyeWide${side}`, wide);
    }
    const squint = has(`EyeSquint${side}`) ? p[`EyeSquint${side}`] : g('EyeSquint');
    setMax(arkit, `eyeSquint${side}`, squint);
    setMax(ue, `EyeSquint${side}`, squint);

    // Brows
    const lower = Math.max(g(`BrowLowerer${side}`), g(`BrowPinch${side}`), g(`BrowDown${side}`));
    const exprBrow = has(`BrowExpression${side}`) ? p[`BrowExpression${side}`] : g('BrowExpression');
    const outer = Math.max(g(`BrowOuterUp${side}`), g('BrowOuterUp'), g('BrowUp'), exprBrow > 0 ? exprBrow : 0);
    const inner = Math.max(g(`BrowInnerUp${side}`), g('BrowInnerUp'), g('BrowUp'), exprBrow > 0 ? exprBrow : 0);
    const down = Math.max(lower, exprBrow < 0 ? -exprBrow : 0);
    setMax(arkit, `browDown${side}`, down);
    setMax(arkit, `browOuterUp${side}`, outer);
    setMax(arkit, 'browInnerUp', inner);
    setMax(ue, `BrowLowerer${side}`, down);
    setMax(ue, `BrowOuterUp${side}`, outer);
    setMax(ue, `BrowInnerUp${side}`, inner);
    setMax(ue, `BrowPinch${side}`, g(`BrowPinch${side}`));

    // Mouth corners
    const sf = has(`SmileFrown${side}`) ? p[`SmileFrown${side}`] : g('SmileFrown');
    const ss = has(`SmileSad${side}`) ? p[`SmileSad${side}`] : g('SmileSad');
    const smile = Math.max(g(`MouthSmile${side}`), g(`MouthCornerPull${side}`), sf > 0 ? sf : 0, ss > 0 ? ss : 0);
    const frown = Math.max(g(`MouthFrown${side}`), g(`MouthSad${side}`), sf < 0 ? -sf : 0, ss < 0 ? -ss : 0);
    setMax(arkit, `mouthSmile${side}`, smile);
    setMax(arkit, `mouthFrown${side}`, frown);
    setMax(ue, `MouthCornerPull${side}`, smile);
    setMax(ue, `MouthCornerSlant${side}`, g(`MouthCornerSlant${side}`));
    setMax(ue, `MouthFrown${side}`, frown);
    for (const k of ['Stretch', 'Dimple', 'Press', 'UpperUp', 'LowerDown']) {
      const v = g(`Mouth${k}${side}`, k === 'UpperUp' ? g('MouthUpperUp') : k === 'LowerDown' ? g('MouthLowerDown') : 0);
      setMax(arkit, `mouth${k}${side}`, v);
      setMax(ue, `Mouth${k}${side}`, v);
    }
    setMax(arkit, `cheekSquint${side}`, has(`CheekSquint${side}`) ? p[`CheekSquint${side}`] : g('CheekSquint'));
    setMax(ue, `CheekSquint${side}`, has(`CheekSquint${side}`) ? p[`CheekSquint${side}`] : g('CheekSquint'));
    setMax(arkit, `noseSneer${side}`, has(`NoseSneer${side}`) ? p[`NoseSneer${side}`] : g('NoseSneer'));
    setMax(ue, `NoseSneer${side}`, has(`NoseSneer${side}`) ? p[`NoseSneer${side}`] : g('NoseSneer'));
    const puff = has(`CheekPuffSuck${side}`) ? p[`CheekPuffSuck${side}`] : g('CheekPuffSuck');
    setMax(ue, `CheekPuff${side}`, puff > 0 ? puff : 0);

    for (const part of ['Upper', 'Lower'] as const) {
      const funnel = has(`LipFunnel${part}${side}`) ? p[`LipFunnel${part}${side}`] : Math.max(g(`LipFunnel${part}`), g('LipFunnel'));
      const pucker = has(`LipPucker${part}${side}`) ? p[`LipPucker${part}${side}`] : Math.max(g(`LipPucker${part}`), g('LipPucker'));
      const suck = has(`LipSuck${part}${side}`) ? p[`LipSuck${part}${side}`] : Math.max(g(`LipSuck${part}`), g('LipSuck'));
      setMax(ue, `LipFunnel${part}${side}`, funnel);
      setMax(ue, `LipPucker${part}${side}`, pucker);
      setMax(ue, `LipSuck${part}${side}`, suck);
      setMax(arkit, 'mouthFunnel', funnel);
      setMax(arkit, 'mouthPucker', pucker);
      setMax(arkit, part === 'Upper' ? 'mouthRollUpper' : 'mouthRollLower', suck);
    }
  }

  const puffAll = Math.max(g('CheekPuffSuckLeft'), g('CheekPuffSuckRight'), g('CheekPuffSuck'));
  setMax(arkit, 'cheekPuff', puffAll > 0 ? puffAll : 0);
  setMax(arkit, 'jawOpen', g('JawOpen'));
  setMax(ue, 'JawOpen', g('JawOpen'));
  setMax(arkit, 'mouthClose', g('MouthClosed'));
  setMax(ue, 'MouthClosed', g('MouthClosed'));
  const jx = g('JawX');
  setMax(arkit, 'jawRight', jx > 0 ? jx : 0);
  setMax(arkit, 'jawLeft', jx < 0 ? -jx : 0);
  setMax(ue, 'JawRight', jx > 0 ? jx : 0);
  setMax(ue, 'JawLeft', jx < 0 ? -jx : 0);
  setMax(arkit, 'jawForward', Math.max(0, g('JawZ')));
  setMax(ue, 'JawForward', Math.max(0, g('JawZ')));
  const mx = has('MouthX') ? p.MouthX : (g('MouthUpperX') + g('MouthLowerX')) / 2;
  setMax(arkit, 'mouthRight', mx > 0 ? mx : 0);
  setMax(arkit, 'mouthLeft', mx < 0 ? -mx : 0);
  setMax(arkit, 'mouthShrugUpper', g('MouthRaiserUpper'));
  setMax(arkit, 'mouthShrugLower', g('MouthRaiserLower'));
  setMax(ue, 'MouthRaiserUpper', g('MouthRaiserUpper'));
  setMax(ue, 'MouthRaiserLower', g('MouthRaiserLower'));
  if (has('MouthOpen')) {
    setMax(arkit, 'mouthUpperUpLeft', p.MouthOpen);
    setMax(arkit, 'mouthUpperUpRight', p.MouthOpen);
    setMax(arkit, 'mouthLowerDownLeft', p.MouthOpen);
    setMax(arkit, 'mouthLowerDownRight', p.MouthOpen);
  }
  setMax(arkit, 'tongueOut', g('TongueOut'));
  setMax(ue, 'TongueOut', g('TongueOut'));

  let gaze: VrcftOutput['gaze'] = null;
  if (has('EyeLeftX') || has('EyeRightX') || has('EyeX') || has('EyeY')) {
    const lx = has('EyeLeftX') ? p.EyeLeftX : g('EyeX');
    const rx = has('EyeRightX') ? p.EyeRightX : g('EyeX');
    const ly = has('EyeLeftY') ? p.EyeLeftY : g('EyeY');
    const ry = has('EyeRightY') ? p.EyeRightY : g('EyeY');
    gaze = { leftX: lx, leftY: ly, rightX: rx, rightY: ry };
    // ARKit gaze shapes (left eye looking right = eyeLookIn, etc.)
    setMax(arkit, 'eyeLookUpLeft', ly > 0 ? ly : 0);
    setMax(arkit, 'eyeLookDownLeft', ly < 0 ? -ly : 0);
    setMax(arkit, 'eyeLookUpRight', ry > 0 ? ry : 0);
    setMax(arkit, 'eyeLookDownRight', ry < 0 ? -ry : 0);
    setMax(arkit, 'eyeLookInLeft', lx > 0 ? lx : 0);
    setMax(arkit, 'eyeLookOutLeft', lx < 0 ? -lx : 0);
    setMax(arkit, 'eyeLookOutRight', rx > 0 ? rx : 0);
    setMax(arkit, 'eyeLookInRight', rx < 0 ? -rx : 0);
  }
  return { arkit, ue, gaze };
}

/**
 * Converts ARKit weights into VRCFaceTracking v2 parameters (used by the capture app).
 */
export function arkitToVrcft(a: Record<string, number>, gaze: { x: number; y: number }): Record<string, number> {
  const g = (k: string) => a[k] || 0;
  const out: Record<string, number> = {};
  for (const side of ['Left', 'Right'] as const) {
    const blink = g(`eyeBlink${side}`);
    const wide = g(`eyeWide${side}`);
    out[`EyeLid${side}`] = clamp01(0.75 * (1 - blink) + 0.25 * wide);
    out[`EyeSquint${side}`] = g(`eyeSquint${side}`);
    out[`BrowLowerer${side}`] = g(`browDown${side}`);
    out[`BrowPinch${side}`] = g(`browDown${side}`) * 0.5;
    out[`BrowInnerUp${side}`] = g('browInnerUp');
    out[`BrowOuterUp${side}`] = g(`browOuterUp${side}`);
    out[`BrowExpression${side}`] = Math.max(-1, Math.min(1, (g('browInnerUp') + g(`browOuterUp${side}`)) / 2 - g(`browDown${side}`)));
    out[`MouthCornerPull${side}`] = g(`mouthSmile${side}`);
    out[`MouthSmile${side}`] = g(`mouthSmile${side}`);
    out[`MouthCornerSlant${side}`] = g(`mouthSmile${side}`) * 0.6;
    out[`MouthFrown${side}`] = g(`mouthFrown${side}`);
    out[`MouthSad${side}`] = g(`mouthFrown${side}`);
    out[`MouthStretch${side}`] = g(`mouthStretch${side}`);
    out[`MouthDimple${side}`] = g(`mouthDimple${side}`);
    out[`MouthPress${side}`] = g(`mouthPress${side}`);
    out[`MouthUpperUp${side}`] = g(`mouthUpperUp${side}`);
    out[`MouthLowerDown${side}`] = g(`mouthLowerDown${side}`);
    out[`CheekSquint${side}`] = g(`cheekSquint${side}`);
    out[`CheekPuffSuck${side}`] = g('cheekPuff');
    out[`NoseSneer${side}`] = g(`noseSneer${side}`);
    out[`SmileFrown${side}`] = g(`mouthSmile${side}`) - g(`mouthFrown${side}`);
    out[`SmileSad${side}`] = g(`mouthSmile${side}`) - g(`mouthFrown${side}`);
    for (const part of ['Upper', 'Lower'] as const) {
      out[`LipFunnel${part}${side}`] = g('mouthFunnel');
      out[`LipPucker${part}${side}`] = g('mouthPucker');
      out[`LipSuck${part}${side}`] = g(part === 'Upper' ? 'mouthRollUpper' : 'mouthRollLower');
    }
  }
  out.EyeLid = (out.EyeLidLeft + out.EyeLidRight) / 2;
  out.EyeSquint = (out.EyeSquintLeft + out.EyeSquintRight) / 2;
  out.JawOpen = g('jawOpen');
  out.MouthClosed = g('mouthClose');
  out.JawX = g('jawRight') - g('jawLeft');
  out.JawZ = g('jawForward');
  out.MouthX = g('mouthRight') - g('mouthLeft');
  out.MouthUpperX = out.MouthX;
  out.MouthLowerX = out.MouthX;
  out.MouthRaiserUpper = g('mouthShrugUpper');
  out.MouthRaiserLower = g('mouthShrugLower');
  out.MouthUpperUp = (g('mouthUpperUpLeft') + g('mouthUpperUpRight')) / 2;
  out.MouthLowerDown = (g('mouthLowerDownLeft') + g('mouthLowerDownRight')) / 2;
  out.MouthOpen = Math.max(out.MouthUpperUp, out.MouthLowerDown);
  out.LipFunnel = g('mouthFunnel');
  out.LipPucker = g('mouthPucker');
  out.LipSuckUpper = g('mouthRollUpper');
  out.LipSuckLower = g('mouthRollLower');
  out.CheekPuffSuck = g('cheekPuff');
  out.TongueOut = g('tongueOut');
  out.BrowInnerUp = g('browInnerUp');
  out.BrowOuterUp = (g('browOuterUpLeft') + g('browOuterUpRight')) / 2;
  out.BrowUp = Math.max(out.BrowInnerUp, out.BrowOuterUp);
  out.BrowDownLeft = g('browDownLeft');
  out.BrowDownRight = g('browDownRight');
  out.BrowExpression = (out.BrowExpressionLeft + out.BrowExpressionRight) / 2;
  out.SmileFrown = (out.SmileFrownLeft + out.SmileFrownRight) / 2;
  out.SmileSad = out.SmileFrown;
  out.EyeX = gaze.x;
  out.EyeY = gaze.y;
  out.EyeLeftX = gaze.x;
  out.EyeRightX = gaze.x;
  out.EyeLeftY = gaze.y;
  out.EyeRightY = gaze.y;
  return out;
}

/** Expression categories for strength / smoothing controls. */
export type FaceCategory = 'blink' | 'gaze' | 'brow' | 'mouth' | 'emotion' | 'other';

export function categoryOf(name: string): FaceCategory {
  const n = name.toLowerCase();
  if (n.startsWith('blink') || n.startsWith('eyeblink') || n === 'eyeclosedleft' || n === 'eyeclosedright') return 'blink';
  if (n.startsWith('look') || n.startsWith('eyelook')) return 'gaze';
  if (n.startsWith('brow')) return 'brow';
  if (['a', 'i', 'u', 'e', 'o', 'aa', 'ih', 'ou', 'ee', 'oh'].includes(n) || n.startsWith('mouth') || n.startsWith('jaw') ||
      n.startsWith('tongue') || n.startsWith('lip') || n.startsWith('cheek')) return 'mouth';
  if (['joy', 'angry', 'sorrow', 'fun', 'surprised', 'happy', 'sad', 'relaxed', 'neutral'].includes(n)) return 'emotion';
  return 'other';
}
