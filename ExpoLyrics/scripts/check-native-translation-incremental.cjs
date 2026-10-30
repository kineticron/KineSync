/* global __dirname */
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { buildSync } = require('esbuild');
const output = buildSync({ entryPoints: [path.resolve(__dirname, '../components/lyrics/native/native-lyrics-model.ts')], bundle: true,
  platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
const moduleObject = { exports: {} };
vm.runInNewContext(output, { module: moduleObject, exports: moduleObject.exports, require });
const { buildNativeRows, nativeScrollSourceKey } = moduleObject.exports;

const makeLines = () => Array.from({ length: 120 }, (_, index) => {
  const start = index * 5000;
  const syllables = [{ text: `lead-${index}`, startTime: start, endTime: start + 1200, isPartOfWord: false }];
  const backgroundSyllables = index % 5 === 0
    ? [{ text: `echo-${index}`, startTime: start + 200, endTime: start + 900, isPartOfWord: false }] : undefined;
  return { lineStartTime: start, lineEndTime: start + 1500, syllables,
    ...(backgroundSyllables ? { backgroundSyllables, backgroundTranslatedText: undefined } : {}) };
});
const countChanged = (before, after) => before.reduce((count, row, index) => count + Number(row !== after[index]), 0);
const countSourceArraysChanged = (before, after, selector) => before.reduce((count, row, index) =>
  count + Number(selector(row) !== selector(after[index])), 0);
const countChangedBackgroundArrays = (before, after) => before.reduce((count, row, index) => {
  const next = after[index];
  return count + Number(row.backgrounds.length !== next.backgrounds.length ||
    row.backgrounds.some((voice, voiceIndex) => voice.paintWords !== next.backgrounds[voiceIndex]?.paintWords));
}, 0);

for (const style of ['amll', 'spicy']) {
  const baseLines = makeLines();
  const base = buildNativeRows(baseLines, style);
  const baseKey = nativeScrollSourceKey(base);
  const translationArrival = baseLines.map((line, index) => ({ ...line, translatedText: `translation-${index}`,
    ...(line.backgroundSyllables ? { backgroundTranslatedText: `background-translation-${index}` } : {}) }));
  const arrival = buildNativeRows(translationArrival, style, false, base);
  assert.equal(arrival.length, 120);
  assert.equal(countChanged(base, arrival), 120, `${style}: every row gets a translation wrapper on late arrival`);
  assert.equal(countSourceArraysChanged(base, arrival, row => row.lead.paintWords), 0,
    `${style}: late translations preserve all 120 main paint-word arrays`);
  assert.equal(countSourceArraysChanged(base, arrival, row => row.lead.words), 0,
    `${style}: late translations preserve all 120 main shaping word arrays`);
  assert.equal(countChangedBackgroundArrays(base, arrival), 0,
    `${style}: late translations preserve all background paint-word arrays`);
  assert.equal(nativeScrollSourceKey(arrival), baseKey,
    `${style}: translations do not change the auto-follow geometry identity`);

  const editedTranslation = translationArrival.map((line, index) => index === 60
    ? { ...line, translatedText: 'updated target translation', backgroundTranslatedText: 'updated background translation' } : line);
  const update = buildNativeRows(editedTranslation, style, false, arrival);
  assert.equal(countChanged(arrival, update), 1, `${style}: one updated translation changes only its row identity`);
  assert.equal(countSourceArraysChanged(arrival, update, row => row.lead.paintWords), 0,
    `${style}: one translation update does not reshape the main voice`);
  assert.equal(countChangedBackgroundArrays(arrival, update), 0,
    `${style}: one background translation update does not reshape background voices`);
  assert.equal(nativeScrollSourceKey(update), baseKey,
    `${style}: translation content updates do not reset auto-follow targets`);

  const changedText = editedTranslation.map((line, index) => index === 60
    ? { ...line, syllables: [{ ...line.syllables[0], text: 'changed source text' }] } : line);
  const textUpdate = buildNativeRows(changedText, style, false, update);
  assert.equal(countChanged(update, textUpdate), 1, `${style}: a main text correction invalidates only its own row`);
  assert.equal(countSourceArraysChanged(update, textUpdate, row => row.lead.paintWords), 1,
    `${style}: changed main text receives newly shaped paint words`);
  assert.notEqual(nativeScrollSourceKey(textUpdate), baseKey,
    `${style}: main text changes invalidate the auto-follow geometry identity`);

  const changedTiming = changedText.map((line, index) => index === 60
    ? { ...line, syllables: line.syllables.map(part => ({ ...part, startTime: part.startTime + 27, endTime: part.endTime + 27 })) } : line);
  const timingUpdate = buildNativeRows(changedTiming, style, false, textUpdate);
  assert.equal(countChanged(textUpdate, timingUpdate), 1, `${style}: a timing-only correction invalidates only its own row`);
  assert.equal(countSourceArraysChanged(textUpdate, timingUpdate, row => row.lead.paintWords), 1,
    `${style}: timing-only source changes rebuild that row's timed paint inputs`);
  assert.notEqual(nativeScrollSourceKey(timingUpdate), nativeScrollSourceKey(textUpdate),
    `${style}: timing-only changes invalidate auto-follow geometry inputs`);

  const immutableClone = timingUpdate.map(row => ({ ...row.line, syllables: row.line.syllables.map(part => ({ ...part })) }));
  const unchanged = buildNativeRows(immutableClone, style, false, timingUpdate);
  assert.equal(countChanged(timingUpdate, unchanged), 0, `${style}: semantically identical immutable packets reuse every row`);
  console.log(`${style}: 120-row translation arrival changed 120 lightweight translation rows, 0 main/background shaping arrays; ` +
    `single-row translation/text/timing updates changed 1 row; timing/text changes invalidate scroll identity, translation changes do not.`);
}
console.log('Native incremental translation checks passed (modeled row/array identities; no device frame or pixel measurement).');

// Actual NativeSkiaVoice hooks, mocked Skia paragraph/shape boundaries. Pin the
// pre-change source commit, never HEAD, so this remains a real before/after test.
const { execFileSync } = require('node:child_process');
const { createVoiceHarness, bundle, currentCode } = require('./check-native-translation-toggle.cjs');
const baselineRef = '6dc7667b2608a4c06f0dee853848e16d82819733';
const baselineSource = file => execFileSync('git', ['show', `${baselineRef}:ExpoLyrics/components/lyrics/native/${file}`],
  { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8' });
const baselineModelCode = buildSync({ stdin: { contents: baselineSource('native-lyrics-model.ts'),
  resolveDir: path.resolve(__dirname, '../components/lyrics/native'), loader: 'ts' }, bundle: true,
  platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
const baselineModule = { exports: {} };
vm.runInNewContext(baselineModelCode, { module: baselineModule, exports: baselineModule.exports, require });
const baselineVoice = bundle(baselineSource('native-skia-voice.tsx'));
const clone = value => JSON.parse(JSON.stringify(value));
function find(node, type) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === type) return node;
  const children = node.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) { const found = find(child, type); if (found) return found; }
  return null;
}
function runSequence(model, code, style, optimized = false) {
  let lines = makeLines(), rows = model.buildNativeRows(lines, style);
  const mounts = new Map();
  const total = () => {
    const counts = { mainParagraphBuilds: 0, mainParagraphLayouts: 0, glyphShapePasses: 0, translationParagraphBuilds: 0 };
    for (const mount of mounts.values()) for (const key of Object.keys(counts)) counts[key] += mount.counters[key];
    return counts;
  };
  const render = nextRows => {
    const result = new Map();
    nextRows.forEach(row => [row.lead, ...row.backgrounds].forEach((voice, index) => {
      const id = `${row.index}:${index}`;
      let mount = mounts.get(id);
      if (!mount) {
        mount = createVoiceHarness(code, style === 'spicy'); mounts.set(id, mount);
        const initial = mount.render(voice, { background: index > 0 });
        initial.props.onLayout({ nativeEvent: { layout: { width: 240 } } });
      }
      const tree = mount.render(voice, { background: index > 0 });
      const glyph = find(tree, mount.NativeGlyphPicture);
      result.set(id, { key: glyph.props.key, words: glyph.props.words, height: tree.props.style[0].height });
    }));
    return result;
  };
  let painted = render(rows);
  const summaries = {};
  for (const stage of ['arrival', 'translation-update', 'main-text', 'main-timing', 'background-text']) {
    const before = total(), previous = rows, oldPainted = painted;
    lines = clone(lines);
    if (stage === 'arrival') lines.forEach((line, index) => {
      line.translatedText = `translation:${index}`;
      if (line.backgroundSyllables) line.backgroundTranslatedText = `translation:background:${index}`;
    });
    if (stage === 'translation-update') { lines[60].translatedText = 'translation:updated'; lines[60].backgroundTranslatedText = 'translation:background:updated'; }
    if (stage === 'main-text') lines[60].syllables[0].text = 'changed lead';
    if (stage === 'main-timing') { lines[60].syllables[0].startTime += 27; lines[60].syllables[0].endTime += 27; }
    if (stage === 'background-text') lines[60].backgroundSyllables[0].text = 'changed echo';
    rows = model.buildNativeRows(lines, style, false, previous);
    painted = render(rows);
    const after = total();
    summaries[stage] = { changedRows: countChanged(previous, rows), ...Object.fromEntries(Object.keys(before).map(key => [key, after[key] - before[key]])) };
    if (optimized && (stage === 'arrival' || stage === 'translation-update')) for (const [id, prior] of oldPainted) {
      assert.equal(painted.get(id).key, prior.key, 'translation preserves each picture key');
      assert.equal(painted.get(id).words, prior.words, 'translation preserves each shaped picture input');
    }
    if (stage === 'arrival') assert(painted.get('60:0').height > oldPainted.get('60:0').height, 'late translation increases only its native row metrics');
    if (stage === 'main-timing') summaries[stage].pictureKeyChanged = painted.get('60:0').key !== oldPainted.get('60:0').key;
  }
  return summaries;
}
for (const style of ['amll', 'spicy']) {
  const before = runSequence(baselineModule.exports, baselineVoice, style);
  const after = runSequence(moduleObject.exports, currentCode, style, true);
  assert.equal(before.arrival.mainParagraphBuilds, 288, 'baseline rebuilds two main paragraphs for each of 120 lead +24 background voices');
  assert.equal(before.arrival.glyphShapePasses, 144);
  assert.equal(after.arrival.mainParagraphBuilds, 0); assert.equal(after.arrival.glyphShapePasses, 0);
  assert.equal(after.arrival.translationParagraphBuilds, 144, 'only required translation paragraphs are built');
  assert.equal(after['translation-update'].changedRows, 1);
  assert.equal(after['translation-update'].translationParagraphBuilds, 2, 'one lead and one background translation are affected');
  assert.equal(after['translation-update'].mainParagraphBuilds, 0);
  for (const stage of ['main-text', 'main-timing', 'background-text']) {
    assert.equal(after[stage].changedRows, 1); assert.equal(after[stage].mainParagraphBuilds, 2);
    assert.equal(after[stage].glyphShapePasses, 1, 'only the actually changed source voice reshapes');
  }
  assert.equal(before['main-timing'].pictureKeyChanged, false, 'baseline demonstrates timing-only paused picture-key hazard');
  assert.equal(after['main-timing'].pictureKeyChanged, true, 'fresh shaping must invalidate the timed picture cache');
  console.log(JSON.stringify({ style, baselineRef, before, after }));
}
console.log('120-row actual native model/hook replay PASS. Counts measure host mocked paragraph/shape calls, not Skia native bytes, rendered pixels, frame timings or device latency.');


// Caches must not cross renderer/static shaping modes, and background metadata
// still affects package/interlude geometry even if AMLL selects a different voice.
for (const style of ['amll', 'spicy']) {
  const lines = makeLines(), original = buildNativeRows(lines, style);
  const otherStyle = style === 'amll' ? 'spicy' : 'amll';
  const switched = buildNativeRows(lines, otherStyle, false, original);
  assert.equal(JSON.stringify(switched), JSON.stringify(buildNativeRows(lines, otherStyle)));
  assert.notEqual(switched[0].lead.paintWords, original[0].lead.paintWords);
  const staticRows = buildNativeRows(lines, style, true, original);
  assert.equal(JSON.stringify(staticRows), JSON.stringify(buildNativeRows(lines, style, true)));
  assert.notEqual(staticRows[0].lead.words, original[0].lead.words);
  const timedAgain = buildNativeRows(lines, style, false, staticRows);
  assert.equal(JSON.stringify(timedAgain), JSON.stringify(original));

  const packages = [{ lineStartTime: 0, lineEndTime: 1000, syllables: [{text:'lead',startTime:0,endTime:1000}],
    spicyBackgrounds: [{lineStartTime:1000,lineEndTime:2500,syllables:[{text:'echo',startTime:1000,endTime:2500}]}] },
    {lineStartTime:6000,lineEndTime:7000,syllables:[{text:'next',startTime:6000,endTime:7000}]}];
  const before = buildNativeRows(packages, style);
  assert.equal(before[1].interlude.start,2500);
  const updated = clone(packages); updated[0].spicyBackgrounds[0].lineEndTime=4500;
  updated[0].spicyBackgrounds[0].syllables[0].endTime=4500;
  const after = buildNativeRows(updated, style, false, before);
  assert.equal(after[0].line.spicyBackgrounds[0].lineEndTime,4500);
  assert.equal(after[1].interlude,undefined,'changed background coverage removes an invalid interlude');
  assert.equal(after[0].lead.paintWords,before[0].lead.paintWords,'background changes do not reshape lead');
  assert.notEqual(nativeScrollSourceKey(after),nativeScrollSourceKey(before));
}
console.log('Mode/static switches and independent background package/interlude propagation PASS.');
