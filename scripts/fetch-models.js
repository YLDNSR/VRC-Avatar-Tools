// Downloads the MediaPipe models used by the capture app and copies the WASM runtime.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const publicDir = path.join(root, 'src', 'public');
const models = {
  'face_landmarker.task': 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  'pose_landmarker_lite.task': 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  'pose_landmarker_full.task': 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
  'hand_landmarker.task': 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
};

async function main() {
  const modelDir = path.join(publicDir, 'models');
  fs.mkdirSync(modelDir, { recursive: true });
  for (const [name, url] of Object.entries(models)) {
    const dest = path.join(modelDir, name);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) { console.log('exists', name); continue; }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    console.log('downloaded', name, fs.statSync(dest).size);
  }
  const wasmSrc = path.join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
  const wasmDest = path.join(publicDir, 'mediapipe', 'wasm');
  fs.mkdirSync(wasmDest, { recursive: true });
  // Electron always supports WASM SIMD, so only the SIMD build is needed.
  for (const f of ['vision_wasm_internal.js', 'vision_wasm_internal.wasm']) fs.copyFileSync(path.join(wasmSrc, f), path.join(wasmDest, f));
  console.log('copied wasm runtime');
}

main().catch((err) => { console.error(err); process.exit(1); });
