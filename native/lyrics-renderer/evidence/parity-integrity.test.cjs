const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hashFile, requireClosure, validateInputs } = require('./parity-integrity.cjs');
test('actual importer closure includes transitive segmentation and translation modules', () => {
  const importer = require.resolve('../../../ExpoLyrics/lib/lyrics-ttml-import');
  require(importer);
  const files = requireClosure(importer);
  for (const name of ['lyricsLineSegmentation.js', 'lyricsTtmlTranslations.js']) {
    assert.ok(files.some(p => p.endsWith('/' + name)), `missing actual parser dependency ${name}`);
  }
});
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-integrity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = name => {
    const file = path.join(dir, name); fs.writeFileSync(file, name);
    return { path: file, sha256: hashFile(file) };
  };
  const packet = input('packet.json');
  fs.writeFileSync(packet.path, '{"generation":1}\n');
  const first = { schema: 2, sources: [input('parser-dependency.js')],
    fonts: [input('regular.otf'), input('bold.otf')], rustHostFonts: { files: [input('fallback.ttc')] },
    rustBinary: input('renderer-binary'), records: [{ id: 'sample', inputPacket: packet.path, inputPacketSha256: hashFile(packet.path) }] };
  return { first, second: structuredClone(first) };
}
test('independent complete inputs and packet digest include exact newline bytes', t => {
  const { first, second } = fixture(t);
  validateInputs(first, second);
  fs.writeFileSync(first.records[0].inputPacket, '{"generation":1}');
  assert.throws(() => validateInputs(first, second), /packet input changed/);
});
for (const name of ['dependency', 'font', 'Rust font', 'binary', 'packet']) {
  const entry = m => name === 'dependency' ? m.sources[0] : name === 'font' ? m.fonts[0]
    : name === 'Rust font' ? m.rustHostFonts.files[0] : name === 'binary' ? m.rustBinary
      : { path: m.records[0].inputPacket };
  test(`publication rejects missing ${name} file`, t => {
    const { first, second } = fixture(t); fs.unlinkSync(entry(first).path);
    assert.throws(() => validateInputs(first, second));
  });
  test(`publication rejects changed ${name} file`, t => {
    const { first, second } = fixture(t); fs.appendFileSync(entry(first).path, 'changed');
    assert.throws(() => validateInputs(first, second), /input changed/);
  });
  test(`publication rejects independent ${name} input mismatch`, t => {
    const { first, second } = fixture(t);
    if (name === 'packet') second.records[0].inputPacketSha256 = '0'.repeat(64);
    else entry(second).sha256 = '0'.repeat(64);
    assert.throws(() => validateInputs(first, second));
  });
}
test('publication requires complete inventories and binary attestation', t => {
  const { first, second } = fixture(t);
  for (const mutate of [m => delete m.fonts, m => delete m.rustHostFonts, m => delete m.rustBinary,
    m => { m.schema = 1; }, m => { m.sources = []; }]) {
    const invalid = structuredClone(first); mutate(invalid);
    assert.throws(() => validateInputs(invalid, second));
  }
});
