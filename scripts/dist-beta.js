// Beta build (`npm run dist:beta`): "VRC Avatar Tools Beta", a separate app with its own bundle id and
// settings folder, so it installs next to the stable app instead of replacing it. Its first launch
// starts from a copy of the stable app's settings (electron/main.js). Output: release-beta/.
const path = require('node:path');
const builder = require('electron-builder');

const root = path.join(__dirname, '..');
const pkg = require('../package.json');

const NAME = 'VRC Avatar Tools Beta';
const config = JSON.parse(JSON.stringify(pkg.build));
config.appId = `${config.appId}.beta`;
config.productName = NAME;
config.directories = { ...config.directories, output: 'release-beta' };
// The packaged package.json: the app name (settings folder, menu) and the beta channel.
config.extraMetadata = { ...(config.extraMetadata || {}), productName: NAME, vavChannel: 'beta' };
config.mac = { ...config.mac, artifactName: 'VRC-Avatar-Tools-Beta-${version}-mac-${arch}.${ext}' };
config.dmg = { ...config.dmg, title: NAME };

builder.build({ projectDir: root, targets: builder.Platform.MAC.createTarget(), config })
  .then((files) => { for (const f of files) console.log(`[dist-beta] ${path.relative(root, f)}`); })
  .catch((err) => { console.error(err); process.exit(1); });
