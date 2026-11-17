const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const moduleObject = { exports: {} };
const source = fs.readFileSync(path.join(__dirname, '../constants/player-layout.ts'), 'utf8');
vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code,
  { module: moduleObject, exports: moduleObject.exports });
const { getLandscapeLayoutMetrics, fitLandscapeArtwork, isLandscapeLayout } = moduleObject.exports;
for (const [width, height] of [[640, 360], [780, 360], [800, 360], [915, 412], [1024, 600], [1280, 800]]) {
  for (const [left, right] of [[0, 24], [24, 0], [44, 24]]) {
    for (const metadataHeight of [86, 110, 150, 200]) {
      const metrics = getLandscapeLayoutMetrics({ viewportWidth: width, viewportHeight: height,
        safeTop: 24, safeBottom: 24, safeLeft: left, safeRight: right });
      const panelHeight = height - 48;
      const art = fitLandscapeArtwork(metrics.artworkSize, panelHeight, metadataHeight);
      assert.ok(art >= 0 && art <= metrics.artworkSize);
      assert.ok(art + metadataHeight + 8 + 24 <= panelHeight, 'cover, metadata, gap and padding fit the safe panel');
      assert.ok(metrics.leftPaneWidth < width / 2, 'lyrics retain most of the width');
    }
  }
  assert.equal(isLandscapeLayout(width, height), true);
  assert.equal(isLandscapeLayout(height, width), false);
}
assert.equal(fitLandscapeArtwork(248, 100, 150), 0, 'an oversized cover cannot consume metadata space');
assert.equal(fitLandscapeArtwork(248, 600, 100), 248, 'ample height retains the existing artwork cap');
console.log('Landscape artwork checks passed: width, safe area, rotation and measured metadata heights.');
