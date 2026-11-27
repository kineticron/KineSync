// Compare release inputs before refreshing source hashes. Run from any directory.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../../..');
const app = path.join(root, 'ExpoLyrics');
const fromApp = createRequire(path.join(app, 'package.json'));
const { buildSync } = fromApp('esbuild');
const { parseTtmlToLyrics } = fromApp('./lib/lyrics-ttml-import');
const { buildRustTrack } = fromApp('./lib/rust-lyrics-protocol');
const songPath = 'DesktopBridge/test/fixtures/lrc-red/ZZA0P2622376.ttml';
const write = process.argv[2] === '--write';
assert.ok(process.argv.length === 2 || (write && process.argv.length === 3), 'Usage: verify-release-fixtures.cjs [--write]');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => fs.readFileSync(path.join(root, file));
const json = file => JSON.parse(read(file));
const lockPath = 'ExpoLyrics/package-lock.json';
assert.equal(json(lockPath).version, '1.3.0');
assert.equal(json(lockPath).packages[''].version, '1.3.0');

const preparationPath = 'ExpoLyrics/lib/rust-lyrics-preparation.ts';
function loadPreparation(source) {
  const compiled = buildSync({
    absWorkingDir: app,
    stdin: {
      contents: source.toString('utf8'),
      resolveDir: path.join(app, 'lib'),
      sourcefile: preparationPath,
      loader: 'ts',
    },
    tsconfig: 'tsconfig.json',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  }).outputFiles[0].text;
  const mod = { exports: {} };
  vm.runInNewContext(compiled, { module: mod, exports: mod.exports, require: fromApp, Intl, __DEV__: false });
  return mod.exports.prepareRustTrack;
}
const prepareRustTrack = loadPreparation(read(preparationPath));
const { lyrics } = parseTtmlToLyrics(read(songPath).toString('utf8'));
const unicodeText = [
  'office   hello?!',
  'e\u0301 👩‍🎤 flags 🇰🇷',
  '你好，世界 かなカナ 한국어',
  'لا שלום bidi',
  'veryveryveryverylongword',
];

function prepare(expected, line, showTranslation) {
  assert.ok(line, 'missing source line');
  const { style, font_scale, landscape } = expected.settings;
  return JSON.parse(prepareRustTrack(expected.track_id, expected.generation,
    [line], style, font_scale, landscape, showTranslation));
}

// The historical fixtures omit explicit lead bounds. The decoder uses the
// enclosing line for those bounds, so require equality before normalizing.
function compareLead(actual, expected, start, end) {
  if (!Object.hasOwn(expected, 'start')) {
    assert.equal(actual.start, start, 'prepared lead start differs from its enclosing line');
    delete actual.start;
  }
  if (!Object.hasOwn(expected, 'end')) {
    assert.equal(actual.end, end, 'prepared lead end differs from its enclosing line');
    delete actual.end;
  }
}

function comparePacket(expected, line, showTranslation, label) {
  const actual = prepare(expected, line, showTranslation);
  const lead = actual.lines[0];
  compareLead(lead.paint, expected.lines[0].paint, lead.start, lead.end);
  assert.deepEqual(actual, expected, label);
}

function compareTypography(c) {
  const [kind, index] = c.name.split('-');
  const i = Number(index);
  assert.ok(Number.isSafeInteger(i));
  assert.ok(kind === 'fixture' || kind === 'unicode');
  const line = kind === 'fixture' ? lyrics[i] : {
    lineStartTime: 0,
    lineEndTime: 2000,
    syllables: [{ text: unicodeText[i], startTime: 0, endTime: 2000 }],
  };
  const packet = prepare({
    settings: { style: c.style, font_scale: 1, landscape: false },
    generation: 1,
    track_id: 'typography',
  }, line, false);
  const actual = packet.lines[0];
  const label = `${c.name} ${c.style} width ${c.width}`;
  assert.equal(actual.start, c.start, label);
  assert.equal(actual.end, c.end, label);
  compareLead(actual.paint, c.original_line.paint, actual.start, actual.end);
  assert.deepEqual(actual, c.original_line, label);
  assert.deepEqual(actual.paint, c.voice, label);
}

const backgroundBaseline = {
  commit: 'd78b46cd7f619d06f43207ce0bf72be3c6a67d73',
  source: preparationPath,
  sha256: '5d6c80dd87d73d12196dd4e8fe18e9ae606802f524988ae1916ad6c3792ed6ef',
};
function compareBackground(fixture) {
  const original = execFileSync('git', ['show', `${backgroundBaseline.commit}:${preparationPath}`], { cwd: root });
  assert.equal(hash(original), backgroundBaseline.sha256, 'historical preparation source differs from the original pin');
  const prepareOriginal = loadPreparation(original);
  assert.equal(fixture.cases.length, 3);
  for (const { name, packet, style } of fixture.cases) {
    const { settings, track_id, generation } = packet;
    assert.equal(settings.style, style, name);
    const lines = packet.lines.map(line => {
      assert.ok(line.atoms.length && line.atoms.every(atom => atom.text), `${name}: each row has lead syllables`);
      const syllables = line.atoms.map(atom => ({ text: atom.text, startTime: atom.start, endTime: atom.end }));
      const blocks = (line.backgrounds ?? []).map(voice => ({
        lineStartTime: voice.start,
        lineEndTime: voice.end,
        syllables: voice.words.map(word => ({
          text: word.text, startTime: word.start, endTime: word.end, isPartOfWord: word.joined,
        })),
      }));
      if (style === 'amll') assert.ok(blocks.length <= 1, `${name}: AMLL combines background speakers`);
      return {
        lineStartTime: line.start, lineEndTime: line.end, oppositeAligned: line.paint.opposite, syllables,
        ...(style === 'amll' ? { backgroundSyllables: blocks[0]?.syllables } : { spicyBackgrounds: blocks }),
      };
    });
    // The Rust fixture deliberately supplies paint words and duet flags. Round-trip
    // that authored input through production transport without changing its layout cases.
    const wire = buildRustTrack(track_id, generation, lines, {
      settings,
      paints: packet.lines.map(line => line.paint),
      backgrounds: packet.lines.map(line => line.backgrounds ?? []),
    });
    assert.deepEqual(JSON.parse(wire), packet, `${name}: authored packet changed in transport`);
    // Compare the entire production preparation result for the corresponding
    // source rows against the exact previously pinned preparation implementation.
    const args = [track_id, generation, lines, style, settings.font_scale, settings.landscape, false];
    assert.deepEqual(JSON.parse(prepareRustTrack(...args)), JSON.parse(prepareOriginal(...args)),
      `${name}: production preparation changed since the background fixture was pinned`);
  }
}

const cases = {
  'appearance-track': fixture => {
    assert.equal(fixture.packets.length, 8);
    for (const item of fixture.packets) {
      comparePacket(item.packet, lyrics[item.fixture_line], false,
        `appearance row ${item.fixture_line} ${item.style} landscape=${item.landscape}`);
    }
  },
  'auxiliary-track': fixture => {
    assert.equal(fixture.packets.length, 8);
    for (const item of fixture.packets) {
      const line = lyrics[item.fixture_line];
      assert.equal(line.translatedText, item.original_translation);
      const label = `auxiliary row ${item.fixture_line} ${item.style} landscape=${item.landscape}`;
      comparePacket(item.visible, line, true, `${label} shown`);
      comparePacket(item.hidden, line, false, `${label} hidden`);
    }
  },
  'typography-policy': fixture => {
    assert.equal(fixture.cases.length, 54);
    for (const c of fixture.cases) compareTypography(c);
  },
  'background-voices': compareBackground,
};

const outputs = [];
for (const [name, compare] of Object.entries(cases)) {
  const file = `native/lyrics-renderer/test/${name}.json`;
  const input = read(file).toString('utf8');
  const fixture = JSON.parse(input);
  compare(fixture);
  const paths = new Set(fixture.sources.map(source => source.path));
  assert.equal(paths.size, fixture.sources.length, `${file}: duplicate source path`);
  if (name !== 'background-voices') {
    paths.add('DesktopBridge/src/lyricsLineSegmentation.js');
    paths.add('DesktopBridge/src/lyricsTtmlTranslations.js');
    paths.add('ExpoLyrics/lib/lyrics-ttml-import.js');
  }
  paths.add(lockPath);
  const sources = [...paths].map(source => ({ path: source, sha256: hash(read(source)) }));
  const oldSources = new Map(fixture.sources.map(source => [source.path, source.sha256]));
  const drift = sources.filter(source => oldSources.get(source.path) !== source.sha256);
  const sourceSection = /^  "sources": \[[\s\S]*?^  \],$/m;
  assert.match(input, sourceSection, `${file}: missing formatted source section`);
  const bytes = input.replace(sourceSection, () => `  "sources": ${JSON.stringify(sources, null, 2).replace(/\n/g, '\n  ')},`);
  assert.deepEqual(JSON.parse(bytes), { ...fixture, sources });
  outputs.push({ file, bytes, drift, sources, sha256: hash(bytes),
    compared: fixture.cases?.length ?? (name === 'auxiliary-track' ? 16 : 8),
    ...(name === 'background-voices' ? { preparationBaseline: backgroundBaseline } : {}) });
}
if (write) {
  for (const output of outputs) {
    if (output.drift.length) fs.writeFileSync(path.join(root, output.file), output.bytes);
  }
}
console.log(JSON.stringify({
  node: process.version,
  icu: process.versions.icu,
  unicode: process.versions.unicode,
  fixtures: outputs.map(({ bytes, ...evidence }) => evidence),
}, null, 2));
if (!write && outputs.some(output => output.drift.length)) {
  console.error('Packet and voice inputs match. Run with --write to refresh their source proofs.');
  process.exitCode = 1;
}
// Run production_wrapping_and_unicode_offset_goldens afterwards to validate
// expected wrapped text and ranges with Rust. This script never rewrites them.
