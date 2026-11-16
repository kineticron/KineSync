// Shared fail-closed attestation for actual raster inputs, including external files.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const hashFile = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function requireClosure(entry, cache = require.cache) {
  const paths = new Set();
  function visit(module) {
    if (!module || paths.has(module.filename)) return;
    paths.add(module.filename);
    for (const child of module.children) visit(child);
  }
  assert.ok(cache[entry], `module not loaded: ${entry}`);
  visit(cache[entry]);
  return [...paths].sort();
}
function inventory(capture) {
  assert.equal(capture.schema, 2, 'capture requires complete-input schema2');
  for (const [name, entries, minimum] of [
    ['sources', capture.sources, 1], ['fonts', capture.fonts, 2],
    ['rustHostFonts.files', capture.rustHostFonts?.files, 1],
  ]) {
    assert.ok(Array.isArray(entries) && entries.length >= minimum, `missing ${name} inventory`);
    for (const entry of entries) {
      assert.ok(typeof entry.path === 'string' && /^[a-f0-9]{64}$/.test(entry.sha256), `invalid ${name} entry`);
    }
  }
  assert.ok(capture.rustBinary?.path && /^[a-f0-9]{64}$/.test(capture.rustBinary.sha256), 'missing Rust binary digest');
  return { sources: capture.sources, fonts: capture.fonts, rustHostFonts: capture.rustHostFonts.files,
    rustBinary: [capture.rustBinary] };
}
function validateInputs(capture, repeat) {
  const first = inventory(capture), second = inventory(repeat);
  for (const name of Object.keys(first)) {
    const normalized = entries => entries.map(({ path, sha256 }) => ({ path, sha256 })).sort((a, b) => a.path.localeCompare(b.path));
    assert.deepEqual(normalized(first[name]), normalized(second[name]), `independent ${name} inputs differ`);
    for (const entry of [...first[name], ...second[name]]) {
      assert.equal(hashFile(entry.path), entry.sha256, `${name} input changed: ${entry.path}`);
    }
  }
  assert.ok(capture.records?.length && repeat.records?.length, 'missing capture records');
  const packets = item => item.records.map(r => {
    assert.ok(r.inputPacket && /^[a-f0-9]{64}$/.test(r.inputPacketSha256), 'missing packet file digest');
    assert.equal(hashFile(r.inputPacket), r.inputPacketSha256, `packet input changed: ${r.inputPacket}`);
    return { id: r.id, sha256: r.inputPacketSha256 };
  }).sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(packets(capture), packets(repeat), 'independent packet inputs differ');
}
module.exports = { hashFile, requireClosure, validateInputs };
