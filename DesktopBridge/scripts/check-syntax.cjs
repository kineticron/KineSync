const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
function filesIn(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesIn(file) : /\.(?:js|cjs|mjs)$/.test(entry.name) ? [file] : [];
  });
}
const files = ['src', 'scripts', 'test'].flatMap(directory => filesIn(path.join(root, directory)));
let failed = false;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) failed = true;
}
console.log(`Checked JavaScript syntax in ${files.length} files.`);
if (failed) process.exitCode = 1;
