const fs = require('node:fs');
const path = require('node:path');

function readReleaseNotes(root, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw new Error('Release version must have three numeric components');
  const file = path.join(root, 'RELEASE_NOTES', `v${version}.md`);
  if (!fs.existsSync(file)) throw new Error(`Add RELEASE_NOTES/v${version}.md before publishing this version`);
  const notes = fs.readFileSync(file, 'utf8').trim();
  if (!notes) throw new Error(`Release notes are empty: ${file}`);
  return notes;
}

if (require.main === module) console.log(readReleaseNotes(path.resolve(__dirname, '..'), process.argv[2]));
module.exports = { readReleaseNotes };
