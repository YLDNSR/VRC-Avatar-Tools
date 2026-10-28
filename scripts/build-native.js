// Builds the native pieces for the current architecture:
//  1. vav_native.node  – N-API addon (shared-memory frames, modifier keys, global key monitor).
//     N-API is ABI-stable, so building against Node headers works in Electron.
//  2. "VRC Avatar Tools Syphon" – helper executable that publishes the frames over Syphon.
//  3. syphon-probe – small Syphon client used to test the output (development only).
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const nativeDir = path.join(root, 'native');
const syphonDir = path.join(nativeDir, 'vendor', 'Syphon-Framework');
const nodeGyp = require.resolve('node-gyp/bin/node-gyp.js');
const arch = process.env.VAV_ARCH || process.arch;
const clangArch = arch === 'x64' ? 'x86_64' : 'arm64';

execFileSync(process.execPath, [nodeGyp, 'rebuild', `--arch=${arch}`], { cwd: nativeDir, stdio: 'inherit' });

const common = [
  '-fobjc-arc', '-O2', '-arch', clangArch, '-mmacosx-version-min=12.0', '-Wno-deprecated-declarations',
  '-DSYPHON_CORE_SHARE', '-include', path.join(syphonDir, 'Syphon_Prefix.pch'),
  '-I', path.join(nativeDir, 'include'), '-I', syphonDir, '-I', path.join(nativeDir, 'src'),
];
const syphonShared = ['SyphonPrivate.m', 'SyphonMessaging.m', 'SyphonMessageReceiver.m', 'SyphonMessageSender.m',
  'SyphonCFMessageReceiver.m', 'SyphonCFMessageSender.m', 'SyphonMessageQueue.m', 'SyphonDispatch.c'].map((f) => path.join(syphonDir, f));
const frameworks = ['-framework', 'Foundation', '-framework', 'AppKit', '-framework', 'IOSurface', '-framework', 'CoreVideo'];

const helperDir = path.join(nativeDir, 'build', 'helper');
fs.mkdirSync(helperDir, { recursive: true });
execFileSync('clang', [
  ...common,
  path.join(nativeDir, 'helper', 'syphon-helper.m'),
  path.join(syphonDir, 'SyphonServerBase.m'), path.join(syphonDir, 'SyphonServerConnectionManager.m'),
  ...syphonShared, ...frameworks,
  '-o', path.join(helperDir, 'VRC Avatar Tools Syphon'),
], { stdio: 'inherit' });

const probeDir = path.join(nativeDir, 'test', 'build');
fs.mkdirSync(probeDir, { recursive: true });
execFileSync('clang', [
  ...common,
  path.join(nativeDir, 'test', 'syphon-probe.m'),
  path.join(syphonDir, 'SyphonServerDirectory.m'), path.join(syphonDir, 'SyphonClientBase.m'),
  path.join(syphonDir, 'SyphonClientConnectionManager.m'),
  ...syphonShared, ...frameworks,
  '-o', path.join(probeDir, 'syphon-probe'),
], { stdio: 'inherit' });

console.log(`native addon + Syphon helper built for ${arch}`);
