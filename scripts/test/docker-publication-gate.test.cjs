const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('Docker candidate CI keeps the image on its runner and has no publication credentials', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../../.github/workflows/docker-image.yml'), 'utf8');
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.match(workflow, /^      - name: Verify patched Spotify and adblockify startup$/m);
  assert.match(workflow, /^          load: true\n          push: false$/m);
  assert.doesNotMatch(workflow, /\b(?:contents|packages|id-token): write\b/);
  assert.doesNotMatch(workflow, /(?:docker\/login-action|upload-artifact|publish-production-release|docker (?:push|login)|gh release|^\s*push: true|^\s*(?:outputs|cache-to):)/m);
});
