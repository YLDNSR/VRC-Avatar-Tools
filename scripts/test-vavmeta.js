// End-to-end test for the VRChat FX sidecar (.vavmeta.json) in the viewer.
// Builds a small glTF fixture (named nodes + morph targets), copies the hand-written sample
// test/vavmeta/SampleAvatar.vavmeta.json next to it and drives the app through VAV_TEST_SCRIPT
// with a temporary user-data folder. Run `npm run build:web` first (npm run test:vavmeta does).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vav-vavmeta-'));
const avatarPath = path.join(work, 'SampleAvatar.gltf');
const shotPath = path.join(work, 'params-panel.png');

// ---------------------------------------------------------------------------
// Fixture: Body (2 primitives, 5 morph targets), Hat, Outfit/{Outfit A, Outfit B}, FX Heart,
// Armature/Hips/Head/Hat/Ribbon (a second "Hat" to exercise duplicate node names).

const SHAPES = ['eye_smile', 'mouth_open', 'angry', 'shrink_feet', 'cheek'];

function buildGltf() {
  const chunks = [];
  const bufferViews = [];
  const accessors = [];
  let offset = 0;
  function vec3(values) {
    const buf = Buffer.from(new Float32Array(values).buffer);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: buf.length });
    chunks.push(buf);
    offset += buf.length;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < values.length; i++) { min[i % 3] = Math.min(min[i % 3], values[i]); max[i % 3] = Math.max(max[i % 3], values[i]); }
    accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: values.length / 3, type: 'VEC3', min, max });
    return accessors.length - 1;
  }
  const tri = (x, y, s) => [x, y, 0, x + s, y, 0, x + s / 2, y + s, 0];
  const prim = (x, y, s, targets = 0) => ({
    attributes: { POSITION: vec3(tri(x, y, s)) },
    targets: Array.from({ length: targets }, () => ({ POSITION: vec3([0, 0, 0.02, 0, 0, 0.02, 0, 0.02, 0.02]) })),
  });
  const meshes = [
    { name: 'Body', primitives: [prim(-0.2, 0.6, 0.4, SHAPES.length), prim(-0.2, 0.1, 0.4, SHAPES.length)], extras: { targetNames: SHAPES } },
    { name: 'HatMesh', primitives: [prim(-0.15, 1.45, 0.3)] },
    { name: 'OutfitAMesh', primitives: [prim(-0.5, 0.6, 0.25)] },
    { name: 'OutfitBMesh', primitives: [prim(0.25, 0.6, 0.25)] },
    { name: 'HeartMesh', primitives: [prim(0.3, 1.2, 0.15)] },
    { name: 'RibbonMesh', primitives: [prim(-0.05, 1.3, 0.1)] },
  ];
  const nodes = [
    { name: 'Body', mesh: 0 },
    { name: 'Hat', mesh: 1 },
    { name: 'Outfit', children: [3, 4] },
    { name: 'Outfit A', mesh: 2 },
    { name: 'Outfit B', mesh: 3 },
    { name: 'FX Heart', mesh: 4 },
    { name: 'Armature', children: [7] },
    { name: 'Hips', children: [8] },
    { name: 'Head', children: [9] },
    { name: 'Hat', children: [10] },
    { name: 'Ribbon', mesh: 5 },
  ];
  const bin = Buffer.concat(chunks);
  return {
    asset: { version: '2.0', generator: 'scripts/test-vavmeta.js' },
    scene: 0,
    scenes: [{ nodes: [0, 1, 2, 5, 6] }],
    nodes,
    meshes,
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.length, uri: `data:application/octet-stream;base64,${bin.toString('base64')}` }],
  };
}

fs.writeFileSync(avatarPath, JSON.stringify(buildGltf()));
fs.copyFileSync(path.join(root, 'test', 'vavmeta', 'SampleAvatar.vavmeta.json'), path.join(work, 'SampleAvatar.vavmeta.json'));

// ---------------------------------------------------------------------------
// Scenario, evaluated in the viewer window. Returns { ok, passed, fails }.

const scenario = `(async () => {
  const app = window.__app;
  const fails = [];
  let passed = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const settle = async () => { app.markActive(); await sleep(700); };
  const check = (label, got, want, tol = 0.03) => {
    const ok = typeof want === 'boolean' ? got === want : Math.abs(got - want) <= tol;
    if (ok) passed++; else fails.push(label + ': got ' + got + ', want ' + want);
  };
  await app.loadAvatar(${JSON.stringify(avatarPath)});
  await settle();
  const a = app.avatar, fx = app.vrc;
  check('sidecar loaded', !!fx, true);
  if (!a || !fx) return { ok: false, passed, fails };
  const top = (name) => a.scene.children.find((c) => c.userData.name === name);
  const byPath = (...names) => names.reduce((n, name) => n && n.children.find((c) => c.userData.name === name), a.scene);
  const morph = (shape) => { const body = top('Body'); const m = body.isMesh ? body : body.children.find((c) => c.isMesh); return m.morphTargetInfluences[m.morphTargetDictionary[shape]]; };
  const hat = top('Hat'), outfitA = byPath('Outfit', 'Outfit A'), outfitB = byPath('Outfit', 'Outfit B');
  const heart = top('FX Heart'), headHat = byPath('Armature', 'Hips', 'Head', 'Hat');
  check('missing paths', fx.missing.size, 0, 0);

  // Defaults + default parameter values
  check('Hat visible (Hat=1)', hat.visible, true);
  check('Outfit A visible', outfitA.visible, true);
  check('Outfit B hidden', outfitB.visible, false);
  check('FX Heart hidden', heart.visible, false);
  check('Head/Hat hidden (Ribbon=0, direct tree)', headHat.visible, false);
  check('shrink_feet from Outfit A', morph('shrink_feet'), 1);
  check('cheek 0', morph('cheek'), 0);

  // Parameters → FX toggles
  fx.set('Hat', 0); fx.set('Outfit', 1); fx.set('Cheek', 0.5); fx.set('Ribbon', 1);
  await settle();
  check('Hat hidden (Hat=0)', hat.visible, false);
  check('Outfit A hidden (Outfit=1)', outfitA.visible, false);
  check('Outfit B visible (Outfit=1)', outfitB.visible, true);
  check('shrink_feet 0 (Outfit=1)', morph('shrink_feet'), 0);
  check('cheek 0.5 (motion time)', morph('cheek'), 0.5);
  check('Head/Hat visible (Ribbon=1)', headHat.visible, true);

  // Gestures use the FX map, not the VRM default (left 2 would be "angry")
  app.gestures.set('left', 2, false); await settle();
  check('left 2 has no FX entry → angry 0', morph('angry'), 0);
  app.gestures.set('left', 1, false); await settle();
  check('left 1 → eye_smile', morph('eye_smile'), 1);
  check('left 1 → FX Heart shown', heart.visible, true);
  app.gestures.set('left', 3, false); await settle();
  check('left 3 → angry 0.8', morph('angry'), 0.8);
  check('left 3 → eye_smile off', morph('eye_smile'), 0);
  check('left 3 → FX Heart hidden', heart.visible, false);
  app.gestures.set('right', 2, false); await settle();
  check('right 2 (most recent hand) → mouth_open', morph('mouth_open'), 1);
  check('right 2 → angry off', morph('angry'), 0);
  app.gestures.set('right', 0, false); app.gestures.set('left', 0, false); await settle();
  check('neutral → mouth_open off', morph('mouth_open'), 0);

  // Params panel: title, Expression Menu rows, toggle through the UI, reset
  fx.reset(); await settle();
  app.togglePanel('params'); await sleep(200);
  const panel = document.querySelector('[data-panel="params"]');
  const title = panel.querySelector('.panel-title').textContent;
  check('Expression Menu shown', !!panel.querySelector('.vrc-menu'), true);
  check('only the menu (no parameter / blendshape tabs)', panel.querySelector('.params-top').classList.contains('hidden'), true);
  const rows = [...panel.querySelectorAll('.param-row')];
  check('menu rows (Hat, Outfit ›, Cheek, Ribbon)', rows.length, 4, 0);
  const hatBox = rows[0].querySelector('input[type=checkbox]');
  hatBox.click(); await settle();
  check('UI toggle Hat off → Hat param 0', fx.get('Hat'), 0, 0);
  check('UI toggle Hat off → Hat hidden', hat.visible, false);
  panel.querySelector('.vrc-submenu').click(); await sleep(200);
  const subRows = [...panel.querySelectorAll('.param-row input[type=checkbox]')];
  check('submenu toggles', subRows.length, 2, 0);
  subRows[1].click(); await settle();
  check('UI Outfit B → Outfit=1', fx.get('Outfit'), 1, 0);
  check('UI Outfit B → Outfit B visible', outfitB.visible, true);
  [...panel.querySelectorAll('button')].find((b) => b.textContent.startsWith('‹')).click(); await sleep(200);
  check('back to the root menu', panel.querySelectorAll('.vrc-menu > .param-row').length, 4, 0);
  return { ok: fails.length === 0, passed, fails, title };
})()`;

const steps = [
  { wait: 1500 },
  { eval: scenario },
  { wait: 300 },
  { shot: shotPath },
  { quit: true },
];
const stepsPath = path.join(work, 'steps.json');
fs.writeFileSync(stepsPath, JSON.stringify(steps));

const electron = require('electron');
const child = spawn(electron, ['.'], {
  cwd: root,
  env: { ...process.env, VAV_TEST_SCRIPT: stepsPath, VAV_USER_DATA: path.join(work, 'userData') },
});
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });
const timer = setTimeout(() => { console.error('timeout'); child.kill(); }, 90000);
child.on('exit', () => {
  clearTimeout(timer);
  const line = out.split('\n').find((l) => l.includes('[test] eval ->'));
  const failedStep = out.split('\n').find((l) => l.includes('[test] step failed'));
  let result = null;
  try { result = line ? JSON.parse(line.slice(line.indexOf('->') + 2)) : null; } catch { /* ignore */ }
  console.log(`fixture: ${work}`);
  if (fs.existsSync(shotPath)) console.log(`screenshot: ${shotPath}`);
  if (!result) {
    console.error('no result from the viewer', failedStep || '');
    console.error(out.split('\n').slice(-30).join('\n'));
    process.exit(1);
  }
  console.log(`passed ${result.passed} checks`);
  for (const f of result.fails) console.error(`FAIL ${f}`);
  process.exit(result.ok ? 0 : 1);
});
