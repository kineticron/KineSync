const { spawnSync } = require('node:child_process');
const path = require('node:path');

// Resolve Forge's node-gyp without depending on npm hoisting and always
// match the app's Electron ABI.
const rebuildDirectory = path.dirname(require.resolve('@electron/rebuild', {
  paths: [path.resolve(__dirname, '../..')],
}));
const nodeGyp = require.resolve('node-gyp/bin/node-gyp.js', { paths: [rebuildDirectory] });
const electronVersion = require('../../package.json').devDependencies.electron;
const result = spawnSync(process.execPath, [nodeGyp, 'rebuild', `--target=${electronVersion}`,
  '--arch=x64', '--dist-url=https://electronjs.org/headers'], { cwd: __dirname, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
