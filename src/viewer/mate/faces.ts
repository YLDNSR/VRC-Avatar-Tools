// Faces the desktop character motion asks for by name. Each one is the first of its candidates the avatar
// has: a VRM expression, or a blendshape with that name (common VRChat / MMD style names), or several
// blendshapes shown together. Names not listed here go to the avatar's usual expression lookup. An avatar
// without any of them just shows nothing.
// MMD style names: なごみ shuts the eyes in a soft curve and にっこり is the smiling mouth; together they
// make the happy face. 笑い comes last: on many VRChat avatars it shuts the eyes so far that they vanish.
// はぅ (> <) only shows its marks at full strength, so it is used at 1 or not at all.

/** One blendshape name (or VRM expression), or several shown together, each at its own strength. */
export type FaceCandidate = string | [string, number][];

export interface FaceDef {
  candidates: FaceCandidate[];
  /** How far it closes the eyes (0..1): blinking is held back by that much */
  eyes?: number;
}

export const FACES: Record<string, FaceDef> = {
  /** Smiling eyes and mouth */
  happy: { candidates: ['happy', [['なごみ', 0.85], ['にっこり', 1]], 'にっこり', 'smile', 'joy', '笑い'], eyes: 0.85 },
  /** Eyes shut in a soft curve (content, humming, dozing) */
  calmEyes: { candidates: ['なごみ', 'relaxed', 'eye_nagomi', 'blink'], eyes: 1 },
  /** Eyes squeezed shut, > < */
  squeeze: { candidates: ['はぅ', '><', 'はう', 'blink'], eyes: 1 },
  /** Half-shut, glaring eyes (pouting) */
  glare: { candidates: ['じと目', 'jitome'], eyes: 0.5 },
  /** Smiling mouth only (the eyes stay open) */
  smileMouth: { candidates: ['にっこり', '口角上げ', 'mouth_smile', 'Fcl_MTH_Fun'] },
  blush: { candidates: ['照れ', 'ほほ染め', '頬染め', 'blush', 'cheek'] },
  /** Pouting mouth */
  pout: { candidates: ['∧', 'むー', 'pout', 'ou'] },
  /** ω mouth */
  catMouth: { candidates: ['ω', 'ω□', 'mouth_ω'] },
  /** Small round open mouth ("oh?") */
  smallO: { candidates: ['▲', 'oh'] },
  /** Wide open smiling mouth */
  openSmile: { candidates: ['ワ', 'あ２', 'aa'] },
  winkLeft: { candidates: ['blinkLeft', 'ウィンク', 'wink_l'], eyes: 0.5 },
  winkRight: { candidates: ['blinkRight', 'ウィンク右', 'wink_r'], eyes: 0.5 },
};
