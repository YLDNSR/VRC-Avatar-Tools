// Writes THIRD_PARTY_NOTICES.md: the licenses of everything the app ships with (the npm packages bundled
// into it and their dependencies, Syphon-Framework compiled into the helper, the MediaPipe models).
// `npm run notices`; the file is copied into the packaged app (package.json build.extraResources).
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
// Packages whose code ends up in the app: the viewer / capture bundles, the main process, the native addon.
const ROOTS = ['three', '@pixiv/three-vrm', '@pixiv/three-vrm-animation', '@mediapipe/tasks-vision', 'yaml', 'smol-toml', 'node-addon-api'];
const TYPES_ONLY = /^@types\/|^@pixiv\/types-/;

function packageDir(name) {
  return path.join(root, 'node_modules', ...name.split('/'));
}

function licenseText(dir, license) {
  const file = fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f));
  if (file) return fs.readFileSync(path.join(dir, file), 'utf8').trim();
  const fallback = path.join(__dirname, 'licenses', `${license}.txt`);
  if (fs.existsSync(fallback)) return fs.readFileSync(fallback, 'utf8').trim();
  throw new Error(`no license text for ${dir} (${license})`);
}

function collect() {
  const seen = new Map();
  const visit = (name) => {
    if (seen.has(name) || TYPES_ONLY.test(name)) return;
    const dir = packageDir(name);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    seen.set(name, { name, version: pkg.version, license: pkg.license, text: licenseText(dir, pkg.license) });
    for (const dep of Object.keys(pkg.dependencies || {})) visit(dep);
  };
  ROOTS.forEach(visit);
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const section = (title, note, text) => [`## ${title}`, '', ...(note ? [note, ''] : []), '```', text, '```', ''];

const lines = [
  '# Third-party notices',
  '',
  'VRC Avatar Tools includes the following third-party software. Electron and Chromium ship their own',
  'notices next to the app (LICENSE.electron.txt, LICENSES.chromium.html).',
  '',
];
for (const p of collect()) lines.push(...section(`${p.name} ${p.version} (${p.license})`, null, p.text));
lines.push(...section('Syphon-Framework (BSD-2-Clause)', 'Compiled into the Syphon helper (macOS).',
  fs.readFileSync(path.join(root, 'native', 'vendor', 'Syphon-Framework', 'License.txt'), 'utf8').trim()));
lines.push(...section('MediaPipe models (Apache-2.0)',
  'face_landmarker, pose_landmarker_lite / full and hand_landmarker by Google, downloaded by scripts/fetch-models.js.',
  fs.readFileSync(path.join(__dirname, 'licenses', 'Apache-2.0.txt'), 'utf8').trim()));

fs.writeFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), lines.join('\n'));
console.log('THIRD_PARTY_NOTICES.md written');
