// Humanoid bone names shared by the viewer and the capture app.
// VRM 1.0 names are used internally; VMC uses Unity HumanBodyBones names.

export const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'] as const;

const vrmToUnityPairs: [string, string][] = [
  ['hips', 'Hips'], ['spine', 'Spine'], ['chest', 'Chest'], ['upperChest', 'UpperChest'],
  ['neck', 'Neck'], ['head', 'Head'], ['leftEye', 'LeftEye'], ['rightEye', 'RightEye'], ['jaw', 'Jaw'],
  ['leftUpperLeg', 'LeftUpperLeg'], ['leftLowerLeg', 'LeftLowerLeg'], ['leftFoot', 'LeftFoot'], ['leftToes', 'LeftToes'],
  ['rightUpperLeg', 'RightUpperLeg'], ['rightLowerLeg', 'RightLowerLeg'], ['rightFoot', 'RightFoot'], ['rightToes', 'RightToes'],
  ['leftShoulder', 'LeftShoulder'], ['leftUpperArm', 'LeftUpperArm'], ['leftLowerArm', 'LeftLowerArm'], ['leftHand', 'LeftHand'],
  ['rightShoulder', 'RightShoulder'], ['rightUpperArm', 'RightUpperArm'], ['rightLowerArm', 'RightLowerArm'], ['rightHand', 'RightHand'],
];
for (const side of ['left', 'right']) {
  const S = side === 'left' ? 'Left' : 'Right';
  vrmToUnityPairs.push([`${side}ThumbMetacarpal`, `${S}ThumbProximal`]);
  vrmToUnityPairs.push([`${side}ThumbProximal`, `${S}ThumbIntermediate`]);
  vrmToUnityPairs.push([`${side}ThumbDistal`, `${S}ThumbDistal`]);
  for (const f of ['Index', 'Middle', 'Ring', 'Little']) {
    vrmToUnityPairs.push([`${side}${f}Proximal`, `${S}${f}Proximal`]);
    vrmToUnityPairs.push([`${side}${f}Intermediate`, `${S}${f}Intermediate`]);
    vrmToUnityPairs.push([`${side}${f}Distal`, `${S}${f}Distal`]);
  }
}

export const VRM_TO_UNITY = new Map<string, string>(vrmToUnityPairs);
export const UNITY_TO_VRM = new Map<string, string>(vrmToUnityPairs.map(([a, b]) => [b, a]));
export const ALL_BONES = vrmToUnityPairs.map(([a]) => a);

export type BoneGroup = 'head' | 'upperBody' | 'lowerBody' | 'arms' | 'eyes';

export function boneGroup(bone: string): BoneGroup {
  if (bone === 'neck' || bone === 'head' || bone === 'jaw') return 'head';
  if (bone === 'leftEye' || bone === 'rightEye') return 'eyes';
  if (bone === 'spine' || bone === 'chest' || bone === 'upperChest') return 'upperBody';
  if (bone === 'hips' || /Leg|Foot|Toes/.test(bone)) return 'lowerBody';
  return 'arms';
}

export function fingerBones(side: 'left' | 'right'): string[][] {
  return [
    [`${side}ThumbMetacarpal`, `${side}ThumbProximal`, `${side}ThumbDistal`],
    [`${side}IndexProximal`, `${side}IndexIntermediate`, `${side}IndexDistal`],
    [`${side}MiddleProximal`, `${side}MiddleIntermediate`, `${side}MiddleDistal`],
    [`${side}RingProximal`, `${side}RingIntermediate`, `${side}RingDistal`],
    [`${side}LittleProximal`, `${side}LittleIntermediate`, `${side}LittleDistal`],
  ];
}
