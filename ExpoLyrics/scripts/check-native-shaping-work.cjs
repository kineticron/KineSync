/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { buildSync } = require('esbuild');
const { bundle, createVoiceHarness, currentCode } = require('./check-native-translation-toggle.cjs');
const before = require('./fixtures/native-shaping-work-before.json');
const native = path.join(__dirname, '../components/lyrics/native');
function load(file) {
  const code = buildSync({ entryPoints: [path.join(native, file)], bundle: true,
    platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require });
  return module.exports;
}
const model = load('native-lyrics-model.ts');
const layouts = { spicy: load('spicy-native-layout.ts'), amll: load('amll-native-layout.ts') };
function find(node, type) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === type) return node;
  for (const child of [node.props?.children].flat()) { const match = find(child, type); if (match) return match; }
  return null;
}
function measure(code) {
  const results = [];
  for (const spicy of [false, true]) for (const id of ['US5TA1500050', 'ZZA0P2622376', 'KRMIM2652961', 'USUM72601821', 'GBUM71805979']) {
    const { lyrics } = require('../lib/lyrics-ttml-import').parseTtmlToLyrics(
      fs.readFileSync(path.join(__dirname, '../../DesktopBridge/test/fixtures/lrc-red', `${id}.ttml`), 'utf8'));
    const rows = model.buildNativeRows(lyrics, spicy ? 'spicy' : 'amll');
    const totals = { voices: 0, withGap: 0, rectQueries: 0, paragraphBuilds: 0,
      spacingProbeBuilds: 0, glyphShapePasses: 0, cueShapePasses: 0 };
    const outputs = [];
    for (const row of rows) for (const voice of [row.lead, ...row.backgrounds]) {
      const harness = createVoiceHarness(code, spicy, layouts);
      let tree = harness.render(voice);
      tree.props.onLayout({ nativeEvent: { layout: { width: 320 } } });
      tree = harness.render(voice);
      totals.voices++;
      if (voice.paintWords.some(word => word.gapAfter)) totals.withGap++;
      for (const key of ['rectQueries', 'paragraphBuilds', 'spacingProbeBuilds', 'glyphShapePasses']) totals[key] += harness.counters[key];
      // All native consumers use rects for ordinary slices, letters only for
      // emphasized slices. The separate paint parity test exercises both paths.
      outputs.push(find(tree, harness.NativeGlyphPicture).props.words.map(word => ({ word: word.word,
        rects: word.rects, ...(word.word.emphasized ? { letters: word.letters } : {}) })));
      const shapes = harness.counters.glyphShapePasses;
      for (let cue = 0; cue < 10; cue++) harness.render(voice);
      totals.cueShapePasses += harness.counters.glyphShapePasses - shapes;
    }
    results.push({ style: spicy ? 'spicy' : 'amll', id, ...totals,
      consumedGlyphInputsSha256: createHash('sha256').update(JSON.stringify(outputs)).digest('hex') });
  }
  return results;
}
const baselineIndex = process.argv.indexOf('--baseline');
if (baselineIndex >= 0) {
  const baselineSource = fs.readFileSync(process.argv[baselineIndex + 1], 'utf8');
  assert.equal(createHash('sha256').update(baselineSource).digest('hex'), before.sourceSha256, 'Baseline is the untouched pinned source');
  const code = bundle(baselineSource);
  assert.deepEqual(measure(code), before.results, 'Pinned untouched baseline reproduces all counts and consumed glyph inputs');
}
const results = measure(currentCode);
for (const [index, row] of results.entries()) {
  const old = before.results[index];
  assert.equal(row.consumedGlyphInputsSha256, old.consumedGlyphInputsSha256);
  assert.equal(row.paragraphBuilds, old.paragraphBuilds);
  assert.equal(row.glyphShapePasses, old.glyphShapePasses);
  assert.equal(row.cueShapePasses, 0);
  assert.ok(row.rectQueries < old.rectQueries, `${row.style}/${row.id}: fewer paragraph range queries`);
}
console.log(JSON.stringify({ label: before.label, baselineCommit: before.commit, results }, null, 2));
