// Windows build (NSIS installer + zip) from macOS: `npm run dist:win`.
//
// electron-builder's NSIS bundle ships an Intel-only `makensis`, which cannot run on Apple Silicon
// without Rosetta (macOS 27 has none by default). In that case this script assembles an NSIS directory
// from Homebrew's native `makensis` (brew install makensis) plus electron-builder's extra plugins and
// elevate.exe, and points electron-builder at it with ELECTRON_BUILDER_NSIS_DIR.
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');

function canRunIntel() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return true;
  return spawnSync('/usr/bin/arch', ['-x86_64', '/usr/bin/true']).status === 0;
}

function brewNsis() {
  for (const prefix of [process.env.HOMEBREW_PREFIX, '/opt/homebrew', '/usr/local'].filter(Boolean)) {
    const dir = path.join(prefix, 'opt', 'makensis');
    if (fs.existsSync(path.join(dir, 'bin', 'makensis'))) return dir;
  }
  return null;
}

/** electron-builder's cached NSIS bundle (for its plugins and elevate.exe). */
function builderBundle() {
  const cache = path.join(os.homedir(), 'Library', 'Caches', 'electron-builder');
  if (!fs.existsSync(cache)) return null;
  for (const version of fs.readdirSync(cache).filter((d) => /^nsis-\d/.test(d)).sort().reverse()) {
    const dir = path.join(cache, version);
    for (const sub of fs.readdirSync(dir)) {
      if (fs.existsSync(path.join(dir, sub, 'elevate.exe'))) return path.join(dir, sub);
    }
  }
  return null;
}

function copyDir(from, to, overwrite) {
  fs.cpSync(from, to, { recursive: true, force: overwrite, errorOnExist: false });
}

function nativeNsisDir() {
  const brew = brewNsis();
  if (!brew) throw new Error('Native makensis not found. Install it with: brew install makensis');
  const bundle = builderBundle();
  if (!bundle) throw new Error('electron-builder NSIS bundle not cached yet (run a Windows build once where Rosetta is available)');
  const out = path.join(os.homedir(), 'Library', 'Caches', 'vrc-avatar-tools', 'nsis-native');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, 'mac'), { recursive: true });
  const share = path.join(brew, 'share', 'nsis');
  for (const name of ['Stubs', 'Include', 'Contrib', 'Plugins']) copyDir(path.join(share, name), path.join(out, name), true);
  fs.copyFileSync(path.join(share, 'nsisconf.nsh'), path.join(out, 'nsisconf.nsh'));
  // electron-builder's own plugins (UAC, nsProcess, StdUtils, …) next to the standard ones, and its
  // language files, which carry the multi-user installer strings NSIS 3.1x lacks (warnings are errors).
  copyDir(path.join(bundle, 'Plugins'), path.join(out, 'Plugins'), false);
  copyDir(path.join(bundle, 'Contrib', 'Language files'), path.join(out, 'Contrib', 'Language files'), true);
  fs.copyFileSync(path.join(bundle, 'elevate.exe'), path.join(out, 'elevate.exe'));
  fs.copyFileSync(path.join(brew, 'bin', 'makensis'), path.join(out, 'mac', 'makensis'));
  fs.chmodSync(path.join(out, 'mac', 'makensis'), 0o755);
  return out;
}

const env = { ...process.env };
if (!canRunIntel() && !env.ELECTRON_BUILDER_NSIS_DIR) {
  env.ELECTRON_BUILDER_NSIS_DIR = nativeNsisDir();
  console.log(`[dist-win] Rosetta unavailable: using native makensis from ${env.ELECTRON_BUILDER_NSIS_DIR}`);
}
execFileSync(process.execPath, [require.resolve('electron-builder/cli.js'), '--win', '--x64'], { cwd: root, env, stdio: 'inherit' });
