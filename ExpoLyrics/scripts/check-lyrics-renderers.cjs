/* global __dirname, Buffer */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildSync } = require('esbuild');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
function load(file) {
  const code = buildSync({ entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'cjs',
    write: false, tsconfig: path.join(root, 'tsconfig.json') }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${code}\n})`)(require, module, module.exports);
  return module.exports;
}
const layout = load('lib/lyrics-layout.ts');
const makeLine = (start, end, text = 'Held words') => ({
  lineStartTime: start, lineEndTime: end,
  syllables: [{ text, startTime: start, endTime: end }],
});
const lines = [makeLine(1000, 4500), makeLine(3000, 5000), makeLine(6500, 8000), makeLine(16000, 18000)];
lines[0].backgroundSyllables = [{ text: 'echo', startTime: 2500, endTime: 5500 }];
function rangeAt(position) {
  const state = layout.getPlaybackWindowState(position, lines);
  return layout.getAutoScrollTargetRange(state, position, lines);
}
assert.deepEqual(rangeAt(3500), { startIndex: 0, endIndex: 1 }, 'overlaps anchor to the first active line');
assert.deepEqual(rangeAt(4800), { startIndex: 0, endIndex: 1 }, 'background extensions stay visible with the next lead');
assert.deepEqual(rangeAt(6000), { startIndex: 2, endIndex: 2 }, 'short gaps move to the next line');
assert.equal(layout.getPlaybackWindowState(10000, lines).isLongPause, true);
assert.equal(layout.getPlaybackWindowState(18000, lines).isLongPause, false);
assert.deepEqual(rangeAt(2000), { startIndex: 0, endIndex: 0 }, 'backward seeks rebuild the range');
assert.equal(layout.getAutoScrollTargetRange(layout.EMPTY_WINDOW_STATE, 0, []), null);
const packageLines = [makeLine(1000, 2000), makeLine(7000, 8000)];
packageLines[0].backgroundSyllables = [{ text: 'echo', startTime: 1800, endTime: 5000 }];
const packageTiming = layout.getLyricTimingIndex(packageLines);
const packageBackgrounds = layout.getBackgroundActiveLines(packageLines);
const packageState = position => layout.getPlaybackWindowState(position, packageLines, packageBackgrounds, packageTiming);
for (const position of [2000, 3500, 4999]) {
  const state = packageState(position);
  assert.equal(state.isLongPause, false, 'a background tail is ongoing lyrics, not an interlude');
  assert.equal(state.activeLineStartIndex, 0, 'the background keeps its own package highlighted');
  assert.deepEqual(layout.getAutoScrollTargetRange(state, position, packageLines), { startIndex: 0, endIndex: 0 },
    'background-only playback stays anchored to its row');
}
assert.equal(packageState(5000).activeLineStartIndex, 1, 'short-gap prehighlight starts when the whole package ends');
assert.equal(packageState(3500).activeLineStartIndex, 0, 'backward seeks restore the background package');
const exactBackgroundLines = [
  { ...makeLine(1000, 2000), spicyBackgrounds: [
    { lineStartTime: 1500, lineEndTime: 6000, syllables: [{ text: 'long echo', startTime: 1500, endTime: 6000 }] },
    { lineStartTime: 2000, lineEndTime: 3000, syllables: [{ text: 'short echo', startTime: 2000, endTime: 3000 }] },
  ] }, makeLine(3500, 4000), makeLine(10000, 11000),
];
assert.equal(layout.getBackgroundEndTime(exactBackgroundLines[0]), 6000, 'all independent background blocks contribute');
const exactState = position => layout.getPlaybackWindowState(position, exactBackgroundLines);
assert.deepEqual(layout.getAutoScrollTargetRange(exactState(3750), 3750, exactBackgroundLines), { startIndex: 0, endIndex: 1 },
  'overlapping backgrounds keep the existing scroll range with the next lead');
assert.deepEqual(layout.getAutoScrollTargetRange(exactState(4500), 4500, exactBackgroundLines), { startIndex: 0, endIndex: 0 },
  'an older background outliving a newer lead remains the scroll anchor');
assert.equal(exactState(6500).pauseStartMs, 6000, 'a real interlude starts after all earlier packages finish');
assert.equal(exactState(6500).pauseVisualDurationMs, 3500, 'dot duration excludes the background tail');
assert.equal(exactState(9500).activeLineStartIndex, 2, 'long-pause early exit still prehighlights the upcoming lyric');
assert.equal(exactState(11000).isLongPause, false, 'song end never allocates pause dots');
for (const anchor of [0, 32]) {
  const padding = layout.getBottomListPadding({ viewportHeight: 400, lyricsLength: 4, lastLineTop: 600, lastLineHeight: 84, creditsLayout: null, hasCredits: false, activeLineTopOffset: anchor });
  assert.equal(600 + 84 + padding - 400, 600 - anchor, 'last row reaches the native anchor without dead space');
}
assert.equal(layout.getCreditsAwareScrollOffset({ range: { startIndex: 3, endIndex: 3 }, lyricsLength: 4, listHeight: 400, creditsLayout: { top: 700, bottom: 1200 }, getAbsoluteLineTop: () => 600, creditsActive: true, hasCredits: true }), 824);

const read = file => fs.readFileSync(path.resolve(root, file), 'utf8');
const settingsSource = read('components/lyrics/settings-menu.tsx');
assert.match(settingsSource, /Lyrics style/);
for (const style of ['amll', 'spicy']) assert.ok(settingsSource.includes(`id: "${style}"`));
const homeSource = read('app/(tabs)/index.tsx');
const settingsScreen = read('app/(tabs)/explore.tsx');
assert.match(settingsScreen, /playbackMode === 'mobile' \? <SettingSection title="Advanced" collapsible>/);
assert.doesNotMatch(settingsScreen, /lyricsRendererBackend|Advanced lyrics settings|>Lyrics renderer<|>Retry save</i);
assert.equal((homeSource.match(/: lyricsRenderer\}/g) ?? []).length, 2, 'both orientations render the same Rust surface');
assert.doesNotMatch(homeSource, /useRustRenderer|lyricsRendererBackend|native-(amll|spicy)-lyrics-view/i);
const home = ts.createSourceFile('index.tsx', homeSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const routingDeclarations = new Map();
function readRouting(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    routingDeclarations.set(node.name.text, node.getText(home));
  }
  ts.forEachChild(node, readRouting);
}
readRouting(home);
const routingBody = ['showLyricsRenderer', 'lyricsRenderer']
  .map(name => `const ${routingDeclarations.get(name)};`).join('\n');
const routingCode = ts.transpileModule(
  `(() => {\n${routingBody}\nreturn lyricsRenderer;\n})();`,
  { compilerOptions: { target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React, jsxFactory: 'jsx' }, fileName: 'routing.tsx' },
).outputText;
for (const isLandscape of [false, true]) for (const lyricsStyle of ['amll', 'spicy']) {
  const handler = () => {};
  const context = {
    jsx: (type, props) => ({ type, props }),
    RustLyricsView: 'rust',
    isLandscape, lyricsStyle, lyricsMounted: true, showEmptyState: false, isScreenFocused: true,
    fullscreenAlbumMode: false, tour: { active: true, foreground: true, onboardingVisible: false },
    showTranslatedText: true, scrubPreviewPositionMs: 7250, tapToSeekEnabled: true,
    autoFollowEnabled: true, resumeAutoFollowSignal: 2,
    previewPlayback: { anchorPositionMs: 7100 }, DEMO_LYRICS: lines, TOUR_DURATION_MS: 25000,
    handleLyricLinePress: handler, handleLineLongPress: handler, handleAutoFollowChange: handler,
    handleSeek: handler, handleControlsInteraction: handler, shouldRevealRustTap: handler, setRustOwnsReveal: handler,
  };
  const view = vm.runInNewContext(routingCode, context);
  assert.equal(view.type, 'rust', 'Rust mounts as soon as lyrics are visible without backend hydration');
  assert.equal(view.props.active, true);
  assert.equal(view.props.demoPlayback, context.previewPlayback);
  assert.equal(view.props.previewPositionMs, 7250);
  assert.equal(view.props.autoFollowEnabled, true);
  assert.equal(view.props.showTranslatedText, true);
  assert.equal(view.props.demoStyle, lyricsStyle);
  for (const prop of ['onLinePress', 'onLineLongPress', 'onAutoFollowChange', 'onCreditsTimestampPress', 'onUserInteraction',
    'shouldRevealTap', 'onRevealOwnershipChange']) {
    assert.equal(view.props[prop], handler, `Rust receives ${prop}`);
  }
}
for (const style of ['amll', 'spicy']) for (const suffix of ['lyrics-view.tsx', 'lyrics-view.native.tsx', 'webview-entry.ts', 'webview-bundle.ts']) {
  assert.equal(fs.existsSync(path.resolve(root, `components/lyrics/${style}-${suffix}`)), false);
}

const { getSpicyWordJoins } = load('components/lyrics/spicy-word-spacing.ts');
assert.deepEqual(getSpicyWordJoins([{ text: '한' }, { text: '글 ' }, { text: '가' }, { text: '사' }]),
  [true, false, true, false], 'KRC Korean syllables join only within source words');
assert.deepEqual(getSpicyWordJoins([{ text: 'some', isPartOfWord: true }, { text: 'thing', isPartOfWord: false }, { text: 'new', isPartOfWord: false }]),
  [true, false, false], 'explicit Spicy join flags remain authoritative');
assert.deepEqual(getSpicyWordJoins([{ text: 'one' }, { text: ' two' }, { text: ' ' }, { text: 'three' }]),
  [false, false, false, false], 'leading/standalone spaces are boundaries too');

const { buildAmllWords, buildAmllShapingWords } = load('components/lyrics/amll-word-spacing.ts');
const { getGraphemes } = load('lib/graphemes.ts');
const { repairSyllableClusters } = load('components/lyrics/cluster-safe-syllables.ts');
for (const [text, expected] of [
  ['कि', ['कि']], ['क्षि', ['क्षि']], ['కై', ['కై']], ['క్షి', ['క్షి']],
  ['น้ำ', ['น้ำ']], ['กิ้', ['กิ้']], ['👩🏽‍💻', ['👩🏽‍💻']], ['e\u0301', ['e\u0301']],
]) {
  assert.deepEqual(getGraphemes(text), expected, `complete clusters: ${text}`);
  const input = Array.from(text, (char, index) => ({ text: char, startTime: index * 300,
    endTime: (index + 1) * 300, isPartOfWord: index < Array.from(text).length - 1 }));
  const snapshot = JSON.stringify(input);
  const repaired = repairSyllableClusters(input);
  assert.deepEqual(repaired.map(part => part.text), expected, `repair timed fragments: ${text}`);
  assert.equal(repaired[0].startTime, 0);
  assert.equal(repaired.at(-1).endTime, input.at(-1).endTime);
  assert.equal(repaired.at(-1).isPartOfWord, false);
  assert.equal(JSON.stringify(input), snapshot, 'provider timing input stays immutable');
  assert.deepEqual(repairSyllableClusters(repaired), repaired, 'repair is idempotent');
  assert.equal(buildAmllWords(input, 0, 5000).map(part => part.word).join(''), text,
    'AMLL adds no spaces inside a repaired cluster');
}
const safeTokens = [{ text: 'Hello ', startTime: 100, endTime: 200 }, { text: 'world', startTime: 200, endTime: 500 }];
assert.deepEqual(repairSyllableClusters(safeTokens), safeTokens, 'safe text and timestamps stay intact');
assert.equal(repairSyllableClusters(safeTokens)[0], safeTokens[0], 'safe tokens retain identity');
const indicFragments = ['क', 'ि', 'ता', 'ब ', 'నీ', 'కు'].map((text, index) => ({
  text, startTime: index * 200, endTime: (index + 1) * 200,
}));
assert.equal(buildAmllWords(indicFragments, 0, 1200).map(word => word.word).join(''), 'किताब నీకు',
  'literal Indic fragments keep safe clusters together without invented word spaces');
const oldIntlSegmenter = Intl.Segmenter;
try {
  Intl.Segmenter = undefined;
  assert.deepEqual(getGraphemes('श्री'), ['श्री'], 'no Intl.Segmenter required');
} finally {
  Intl.Segmenter = oldIntlSegmenter;
}
const amllFlagged = buildAmllWords([
  { text: 'Hel', startTime: 1000, endTime: 1200, isPartOfWord: true },
  { text: 'lo', startTime: 1200, endTime: 1500, isPartOfWord: false },
  { text: 'wor', startTime: 1600, endTime: 1800, isPartOfWord: true },
  { text: 'ld', startTime: 1800, endTime: 2100, isPartOfWord: false },
], 1000, 2100);
assert.deepEqual(amllFlagged.map((w) => w.word), ['Hel', 'lo ', 'wor', 'ld'],
  'Spicy animation preserves timing fragments with a boundary separator');
assert.equal(amllFlagged[0].startTime, 1000, 'grouped word starts at its first fragment');
assert.deepEqual(amllFlagged.map(({ startTime, endTime }) => [startTime, endTime]),
  [[1000, 1200], [1200, 1500], [1600, 1800], [1800, 2100]],
  'animation preserves every provider timing interval');
assert.equal(amllFlagged[1].timedGraphemeCount, 2, 'separator has no animation duration');
assert.deepEqual(buildAmllShapingWords([
  { text: 'Hel', startTime: 1000, endTime: 1200, isPartOfWord: true },
  { text: 'lo', startTime: 1200, endTime: 1500, isPartOfWord: false },
  { text: 'wor', startTime: 1600, endTime: 1800, isPartOfWord: true },
  { text: 'ld', startTime: 1800, endTime: 2100, isPartOfWord: false },
], 1000, 2100), [
  { word: 'Hello ', startTime: 1000, endTime: 1500 },
  { word: 'world', startTime: 1600, endTime: 2100 },
], 'shaping groups retain whole words and their complete timing spans');
assert.equal(amllFlagged.map((w) => w.word).join(''), 'Hello world',
  'AMLL joins grouped words into the correct line text');
const amllPunct = buildAmllWords([
  { text: 'Hello', startTime: 1000, endTime: 1500, isPartOfWord: false },
  { text: ',', startTime: 1500, endTime: 1600, isPartOfWord: false },
  { text: 'world', startTime: 1600, endTime: 2100, isPartOfWord: false },
], 1000, 2100);
assert.equal(amllPunct.map((w) => w.word).join(''), 'Hello, world',
  'closing punctuation clings without a synthesized gap');
const amllCjk = buildAmllWords([
  { text: '光', startTime: 1000, endTime: 1200, isPartOfWord: false },
  { text: 'の', startTime: 1200, endTime: 1400, isPartOfWord: false },
], 1000, 1400);
assert.equal(amllCjk.map((w) => w.word).join(''), '光の',
  'CJK word boundaries take no space');
// Spicy-syllable Korean uses the same join flags as English; each false flag
// ends a word even when both sides of the boundary are Hangul.
const koreanFlagged = [
  { text: '한', startTime: 1000, endTime: 1200, isPartOfWord: true },
  { text: '글', startTime: 1200, endTime: 1500, isPartOfWord: false },
  { text: '가', startTime: 1600, endTime: 1800, isPartOfWord: true },
  { text: '사', startTime: 1800, endTime: 2100, isPartOfWord: false },
];
const koreanSnapshot = JSON.stringify(koreanFlagged);
assert.deepEqual(buildAmllShapingWords(koreanFlagged, 1000, 2100), [
  { word: '한글 ', startTime: 1000, endTime: 1500 },
  { word: '가사', startTime: 1600, endTime: 2100 },
], 'Spicy Korean word boundaries survive AMLL conversion with grouped timings');
assert.equal(JSON.stringify(koreanFlagged), koreanSnapshot, 'Korean provider input stays intact');
for (const [parts, expected] of [
  [['한글', 'rap', '가사'], '한글 rap 가사'],
  [['한글 ', '가사'], '한글 가사'],
  [['한글', ' 가사'], '한글 가사'],
  [['한글', ',', '가사'], '한글, 가사'],
  [['中', '文'], '中文'],
]) {
  const input = parts.map((text, index) => ({
    text, startTime: index * 200, endTime: (index + 1) * 200, isPartOfWord: false,
  }));
  assert.equal(buildAmllWords(input, 0, parts.length * 200).map(word => word.word).join(''),
    expected, `flagged word spacing: ${expected}`);
}
const amllLiteral = buildAmllWords([
  { text: '한', startTime: 1000, endTime: 1500 },
  { text: '글 ', startTime: 1500, endTime: 2000 },
  { text: '테', startTime: 2000, endTime: 2500 },
], 1000, 2500);
assert.deepEqual(amllLiteral.map((w) => w.word), ['한', '글 ', '테'],
  'unflagged syllables pass through 1:1 with literal spacing intact');
assert.equal(amllLiteral.map((w) => w.word).join(''), '한글 테',
  'literal trailing spaces survive the AMLL bridge');

const amllAposEnding = buildAmllWords([
  { text: "lil'", startTime: 1000, endTime: 1200, isPartOfWord: false },
  { text: "pose", startTime: 1200, endTime: 1500, isPartOfWord: false },
], 1000, 1500);
assert.equal(amllAposEnding.map((w) => w.word).join(''), "lil' pose",
  'words ending in apostrophes separate properly from the next word');

const amllAposLeading = buildAmllWords([
  { text: "sing", startTime: 1000, endTime: 1200, isPartOfWord: false },
  { text: "'cause", startTime: 1200, endTime: 1500, isPartOfWord: false },
], 1000, 1500);
assert.equal(amllAposLeading.map((w) => w.word).join(''), "sing 'cause",
  'words starting with apostrophes separate properly from the previous word');

const amllTellEm = buildAmllWords([
  { text: "tell", startTime: 1000, endTime: 1200, isPartOfWord: false },
  { text: "'em", startTime: 1200, endTime: 1500, isPartOfWord: false },
], 1000, 1500);
assert.equal(amllTellEm.map((w) => w.word).join(''), "tell 'em",
  "'em does not merge into the preceding verb");

const amllRockNRoll = buildAmllWords([
  { text: "rock", startTime: 1000, endTime: 1200, isPartOfWord: false },
  { text: "'n'", startTime: 1200, endTime: 1400, isPartOfWord: false },
  { text: "roll", startTime: 1400, endTime: 1600, isPartOfWord: false },
], 1000, 1600);
assert.equal(amllRockNRoll.map((w) => w.word).join(''), "rock 'n' roll",
  "rock 'n' roll preserves spaces around 'n'");

const amllContraction = buildAmllWords([
  { text: "It", startTime: 1000, endTime: 1200, isPartOfWord: false },
  { text: "'s", startTime: 1200, endTime: 1400, isPartOfWord: false },
  { text: "fine", startTime: 1400, endTime: 1600, isPartOfWord: false },
], 1000, 1600);
assert.equal(amllContraction.map((w) => w.word).join(''), "It's fine",
  "apostrophe contractions attach without space and separate from next word");

const amllQuotes = buildAmllWords([
  { text: "said,", startTime: 1000, endTime: 1200, isPartOfWord: false },
  { text: '"Hello"', startTime: 1200, endTime: 1500, isPartOfWord: false },
  { text: "world", startTime: 1500, endTime: 1800, isPartOfWord: false },
], 1000, 1800);
assert.equal(amllQuotes.map((w) => w.word).join(''), 'said, "Hello" world',
  'quoted words maintain spaces on both sides');

// Exercise the real Spicy parsers before conversion, including background lanes.
for (const mobile of [false, true]) {
  const context = vm.createContext({
    Buffer, console, URL, URLSearchParams, TextDecoder, AbortController,
    setTimeout, clearTimeout, setInterval, clearInterval,
    module: { exports: {} }, global: {}, process: { env: {} },
    require: require('node:module').createRequire(path.resolve(root, '../DesktopBridge/src/lyricsService.js')),
  });
  if (mobile) {
    const source = fs.readFileSync(path.resolve(root, 'lib/mobile-lyrics-service.js'), 'utf8')
      .replace(/^import .*;\r?\n/gm, '');
    vm.runInContext(source.slice(0, source.indexOf('export {')), context);
  } else {
    const directory = path.resolve(root, '../DesktopBridge/src/lyrics');
    const index = fs.readFileSync(path.join(directory, 'index.js'), 'utf8');
    const parts = index.match(/const partFiles = \[([\s\S]*?)\];/)[1];
    for (const match of parts.matchAll(/"([^"]+)"/g)) {
      vm.runInContext(fs.readFileSync(path.join(directory, 'parts', match[1]), 'utf8'), context);
    }
  }
  for (const [parts, expected] of [
    [[['한', true], ['글', false], ['가', true], ['사', false]], '한글 가사'],
    [[['한글', false], ['rap', false], ['가사', false]], '한글 rap 가사'],
    [[['光', true], ['の', false]], '光の'],
    [[['中', true], ['文', false]], '中文'],
    [[['Hel', true], ['lo', false], [',', false], ['world', false]], 'Hello, world'],
    [[["It", true], ["'s", false], ['fine', false]], "It's fine"],
    [[['c\'', true], ['est', false], ['bien', false]], "c'est bien"],
  ]) {
    const block = { StartTime: 1, EndTime: 4, Syllables: parts.map(([Text, IsPartOfWord], index) => ({
      Text, IsPartOfWord, StartTime: 1 + index * 0.2, EndTime: 1.2 + index * 0.2,
    })) };
    context.payload = { Type: 'Syllable', Content: [{ Type: 'Vocal', Lead: block, Background: [block] }] };
    const snapshot = JSON.stringify(context.payload);
    const parsed = vm.runInContext('parseSpicyLyrics(payload, 4000)', context);
    assert.equal(parsed.length, 1);
    for (const syllables of [parsed[0].syllables, parsed[0].backgroundSyllables]) {
      const words = buildAmllWords(syllables, 1000, 4000);
      assert.equal(words.map(word => word.word).join(''), expected,
        `${mobile ? 'mobile' : 'desktop'} parser to AMLL: ${expected}`);
      assert.equal(words[0].startTime, 1000);
      assert.equal(words.at(-1).endTime, Math.round(block.Syllables.at(-1).EndTime * 1000));
    }
    assert.equal(JSON.stringify(context.payload), snapshot, 'parser keeps provider payload intact');
  }
  if (!mobile) continue;
  // Modeled mobile BG tail and overlap, not a captured EXO payload. Provider access
  // requires authorization. Keep independent source seconds through Rust paint.
  const block = (text, start, end) => ({ StartTime: start, EndTime: end,
    Syllables: text.map((Text, index) => ({ Text, IsPartOfWord: false,
      StartTime: start + (end - start) * index / text.length,
      EndTime: start + (end - start) * (index + 1) / text.length })) });
  context.payload = { Type: 'Syllable', Content: [
    { Type: 'Vocal', Lead: block(['main'], 1, 2),
      Background: [block(['echo', 'tail'], 2, 4), block(['response'], 2.5, 3.5)] },
    { Type: 'Vocal', Lead: block(['next'], 3, 5) },
  ] };
  const parsed = vm.runInContext('parseSpicyLyrics(payload, 5000)', context);
  const { prepareRustTrack } = load('lib/rust-lyrics-preparation.ts');
  const packet = JSON.parse(prepareRustTrack('modeled-bg-tail', 1, parsed, 'spicy'));
  assert.equal(parsed[0].lineEndTime, 2000, 'lead interval stays separate');
  assert.equal(layout.getBackgroundEndTime(parsed[0]), 4000, 'effective end includes all BGs');
  assert.equal(packet.lines[0].end, 2000);
  assert.equal(packet.lines[0].background_end, 4000);
  assert.equal(packet.lines[1].start, 3000, 'overlapping main keeps its start');
  assert.deepEqual(packet.lines[0].backgrounds.map(voice => [voice.start, voice.end]),
    [[2000, 4000], [2500, 3500]]);
  assert.deepEqual(packet.lines[0].backgrounds[0].words.map(word => [word.start, word.end]),
    [[2000, 3000], [3000, 4000]], 'BG syllable clocks survive preparation');
  for (const time of [1999, 2000, 2001, 2999, 3000, 3999, 4000, 2500]) {
    const window = layout.getPlaybackWindowState(time, parsed);
    assert.equal(window.focusLineIndex, time < 4000 ? 0 : 1, 'focus holds through BG tail and backward seek');
    assert.equal(window.visualActiveLineStartIndex, time < 4000 ? 0 : 1);
    assert.equal(window.visualActiveLineEndIndex, time < 3000 ? 0 : 1, 'next main activates during prior BG');
  }
}
console.log('Spicy parser-to-AMLL checks passed for desktop/mobile lead and background spacing.');

// Optional local provider snapshots: do not commit complete song lyrics.
if (process.argv.includes('--song-fixtures')) {
  for (const file of ['xibal-krc.json', 'cluster-lyrics/thai.json', 'cluster-lyrics/hindi.json', 'cluster-lyrics/telugu.json']) {
    const fixture = JSON.parse(fs.readFileSync(path.resolve(root, '.expo', file), 'utf8'));
    let lanes = 0;
    for (const line of fixture.lyrics) {
      for (const syllables of [line.syllables, line.backgroundSyllables]) {
        if (!syllables?.length) continue;
        assert.ok(syllables.every(part => typeof part.isPartOfWord !== 'boolean'),
          'these saved provider songs use literal spacing');
        const snapshot = JSON.stringify(syllables);
        const words = buildAmllWords(syllables, line.lineStartTime, line.lineEndTime);
        assert.equal(words.map(word => word.word).join(''), syllables.map(part => part.text || '').join(''),
          `${file}: complete source line spacing survives AMLL conversion`);
        assert.equal(words[0].startTime, syllables[0].startTime);
        assert.equal(words.at(-1).endTime, syllables.at(-1).endTime);
        assert.equal(JSON.stringify(syllables), snapshot);
        lanes++;
      }
    }
    assert.ok(lanes > 0);
    console.log(`Provider song passed: ${file} (${lanes} lanes)`);
  }
}
console.log('Lyrics checks passed: renderer routing, timelines, spacing, shaping and provider parsing.');
