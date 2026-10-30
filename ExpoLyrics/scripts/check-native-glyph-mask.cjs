/* global __dirname */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { buildSync } = require('esbuild');

const filename = path.join(__dirname, '../components/lyrics/native/native-glyph-mask.ts');
const source = fs.readFileSync(filename, 'utf8');
assert.ok(!source.includes('\\p{') && !source.includes('\\P{') && !source.includes('\\u{'),
  'The classifier must parse without Unicode property or code-point escapes');
const cases = [
  ['', false], ['?!,', false], ['yeah,', false], ['♪', false], ['中한글', false],
  ['#*0123456789', false], ['.,!?;:()[]{}…—', false], ['𝄞𝔸', false], ['a\u200Db', false], ['♡', true], ['♡ yeah,', true], ['♥', true],
  ['😀', true], ['🇺🇸', true], ['🇺', true], ['1️⃣', true], ['1\u20E3', true],
  ['❤️', true], ['👩‍🎤', true], ['👍🏽', true], ['🏽', true], ['🫩', true],
  ['©', true], ['™', true], ['☀', true], ['♪\uFE0F', true],
  ['⚙', true], ['⚙\uFE0E', false], ['☀\uFE0E', false], ['♡\uFE0E', false], ['♪\uFE0E', false], ['😀\uFE0E', false],
  ['\uD83D', false], ['\uDE00', false],
];
// Execute the actual production helper, with fixed expectations, under the host
// runtime. This is not evidence of Hermes execution or iOS rendering.
const bundle = buildSync({ stdin: { contents: source, loader: 'ts' },
  format: 'cjs', platform: 'node', write: false }).outputFiles[0].text;
const moduleObject = { exports: {} };
vm.runInNewContext(bundle, { module: moduleObject, exports: moduleObject.exports });
for (const [text, expected] of cases) {
  assert.equal(moduleObject.exports.needsEmojiMask(text), expected, JSON.stringify(text));
}

// Optional compiler-only check, using the installed RN Hermes toolchain:
// node scripts/check-native-glyph-mask.cjs --hermesc node_modules/hermes-compiler/hermesc/linux64-bin/hermesc
const compilerArg = process.argv.indexOf('--hermesc');
if (compilerArg >= 0) {
  const compiler = process.argv[compilerArg + 1];
  assert.ok(compiler, 'Supply the hermesc path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kinesync-glyph-mask-'));
  try {
    // Transform the actual production source; the probe calls that same helper.
    const probe = buildSync({ stdin: { loader: 'ts', contents: source + `
      for (const [text, expected] of ${JSON.stringify(cases)}) {
        if (needsEmojiMask(text) !== expected) throw new Error(JSON.stringify(text));
      }
      print('Hermes glyph mask execution passed');
    ` }, format: 'iife', target: 'es2015', write: false }).outputFiles[0].text;
    const input = path.join(directory, 'probe.js');
    const output = path.join(directory, 'probe.hbc');
    fs.writeFileSync(input, probe);
    const result = spawnSync(compiler, ['-emit-binary', '-out', output, input], { encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.statSync(output).size > 0);
    console.log('Hermes classifier probe compiled; NOT executed (compiler-only evidence).');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
console.log('Native glyph mask checks passed: fixed BMP/supplementary coverage, FE0E suppression, punctuation and text.');
