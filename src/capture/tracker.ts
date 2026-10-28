// MediaPipe face / pose / hand landmarkers running on the camera stream.
import { FilesetResolver, FaceLandmarker, PoseLandmarker, HandLandmarker, type FaceLandmarkerResult, type PoseLandmarkerResult, type HandLandmarkerResult } from '@mediapipe/tasks-vision';

export interface TrackFrame {
  time: number;
  face: FaceLandmarkerResult | null;
  pose: PoseLandmarkerResult | null;
  hands: HandLandmarkerResult | null;
}

const base = new URL('./', location.href).href;

export class Tracker {
  face: FaceLandmarker | null = null;
  pose: PoseLandmarker | null = null;
  hands: HandLandmarker | null = null;
  ready = false;
  private model: 'lite' | 'full' = 'lite';
  private lastTs = 0;

  async init(model: 'lite' | 'full', withHands: boolean) {
    const fileset = await FilesetResolver.forVisionTasks(`${base}mediapipe/wasm`);
    const delegate = 'GPU' as const;
    this.face = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: `${base}models/face_landmarker.task`, delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    });
    this.pose = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: `${base}models/pose_landmarker_${model}.task`, delegate },
      runningMode: 'VIDEO',
      numPoses: 1,
    });
    if (withHands) {
      this.hands = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: `${base}models/hand_landmarker.task`, delegate },
        runningMode: 'VIDEO',
        numHands: 2,
      });
    }
    this.model = model;
    this.ready = true;
  }

  async setOptions(model: 'lite' | 'full', withHands: boolean) {
    if (!this.ready) return;
    if (model !== this.model) {
      const fileset = await FilesetResolver.forVisionTasks(`${base}mediapipe/wasm`);
      this.pose?.close();
      this.pose = await PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: `${base}models/pose_landmarker_${model}.task`, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numPoses: 1,
      });
      this.model = model;
    }
    if (withHands && !this.hands) {
      const fileset = await FilesetResolver.forVisionTasks(`${base}mediapipe/wasm`);
      this.hands = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: `${base}models/hand_landmarker.task`, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numHands: 2,
      });
    } else if (!withHands && this.hands) {
      this.hands.close();
      this.hands = null;
    }
  }

  detect(video: HTMLVideoElement, wantBody: boolean): TrackFrame {
    let ts = performance.now();
    if (ts <= this.lastTs) ts = this.lastTs + 1;
    this.lastTs = ts;
    const face = this.face ? this.face.detectForVideo(video, ts) : null;
    const pose = wantBody && this.pose ? this.pose.detectForVideo(video, ts) : null;
    const hands = wantBody && this.hands ? this.hands.detectForVideo(video, ts) : null;
    return { time: ts, face, pose, hands };
  }
}
