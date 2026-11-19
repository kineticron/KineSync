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
function validateManifestSchema(manifest) {
  assert.equal(manifest.schema, 2, 'manifest schema must be 2');
  const allowedTopLevel = new Set([
    'schema', 'manifest_id', 'scope', 'fixture_source', 'fixtures',
    'viewports', 'styles', 'expected_record_ids', 'capabilities',
    'rendering_contract', 'fonts', 'honest_limitations'
  ]);
  for (const key of Object.keys(manifest)) {
    assert.ok(allowedTopLevel.has(key), `unknown manifest property: ${key}`);
  }

  // Validate fixtures
  assert.ok(Array.isArray(manifest.fixtures) && manifest.fixtures.length > 0, 'manifest requires fixtures array');
  const fixtureIds = new Set();
  const allowedFixtureKeys = new Set([
    'id', 'line_index', 'line_start_ms', 'line_end_ms', 'time_ratio',
    'time_ms', 'expected_text', 'description', 'baseline_thresholds'
  ]);
  const allowedThresholdKeys = new Set([
    'min_foreground_score', 'min_foreground_alpha_score', 'min_coverage_ratio',
    'min_ink_pixels_1x', 'min_ink_pixels_3x', 'max_mean_rgb_delta', 'max_mean_alpha_delta',
    'min_mean_rust_ink_alpha', 'max_outside_alpha'
  ]);
  for (const f of manifest.fixtures) {
    for (const key of Object.keys(f)) {
      assert.ok(allowedFixtureKeys.has(key), `unknown fixture property in ${f.id}: ${key}`);
    }
    assert.ok(typeof f.id === 'string' && f.id.length > 0, 'fixture missing id');
    assert.ok(!fixtureIds.has(f.id), `duplicate fixture id: ${f.id}`);
    fixtureIds.add(f.id);
    assert.ok(typeof f.line_index === 'number' && f.line_index >= 0, `invalid line_index in ${f.id}`);
    assert.ok(typeof f.time_ms === 'number', `invalid time_ms in ${f.id}`);
    assert.ok(typeof f.expected_text === 'string' && f.expected_text.length > 0, `missing expected_text in ${f.id}`);
    assert.ok(typeof f.baseline_thresholds === 'object' && f.baseline_thresholds !== null, `missing baseline_thresholds in ${f.id}`);
    for (const thKey of Object.keys(f.baseline_thresholds)) {
      assert.ok(allowedThresholdKeys.has(thKey), `unknown threshold property in ${f.id}: ${thKey}`);
    }
  }

  // Validate viewports
  assert.ok(Array.isArray(manifest.viewports) && manifest.viewports.length > 0, 'manifest requires viewports array');
  const allowedViewportKeys = new Set(['name', 'width', 'height', 'dpr', 'strict_dimensions']);
  for (const vp of manifest.viewports) {
    for (const key of Object.keys(vp)) {
      assert.ok(allowedViewportKeys.has(key), `unknown viewport property: ${key}`);
    }
    assert.ok(typeof vp.width === 'number' && vp.width > 0, `invalid viewport width: ${vp.width}`);
    assert.ok(typeof vp.height === 'number' && vp.height > 0, `invalid viewport height: ${vp.height}`);
    assert.ok(typeof vp.dpr === 'number' && vp.dpr > 0, `invalid viewport dpr: ${vp.dpr}`);
    if (vp.strict_dimensions) {
      assert.equal(vp.strict_dimensions.width, vp.width * vp.dpr, `contradictory strict_dimensions width for ${vp.name}`);
      assert.equal(vp.strict_dimensions.height, vp.height * vp.dpr, `contradictory strict_dimensions height for ${vp.name}`);
    }
  }

  // Validate styles
  assert.ok(Array.isArray(manifest.styles) && manifest.styles.length > 0, 'manifest requires styles array');
  const allowedStyleKeys = new Set(['name', 'font_size_scale', 'line_height_scale', 'rust_supported', 'rust_fallback_behavior']);
  for (const st of manifest.styles) {
    for (const key of Object.keys(st)) {
      assert.ok(allowedStyleKeys.has(key), `unknown style property: ${key}`);
    }
    assert.ok(typeof st.font_size_scale === 'number', `invalid font_size_scale in ${st.name}`);
    assert.ok(typeof st.line_height_scale === 'number', `invalid line_height_scale in ${st.name}`);
    assert.equal(st.rust_supported, false, `Rust baseline ABI3 does not support styles; rust_supported must be false for ${st.name}`);
  }

  // Mandatory Cartesian product completeness and uniqueness
  const expectedIds = [];
  for (const f of manifest.fixtures) {
    for (const vp of manifest.viewports) {
      for (const st of manifest.styles) {
        expectedIds.push(`${f.id}-${vp.width}x${vp.height}-${vp.dpr}x-${st.name}`);
      }
    }
  }
  assert.equal(new Set(expectedIds).size, expectedIds.length, 'Cartesian product contains duplicate record IDs');
  assert.ok(Array.isArray(manifest.expected_record_ids), 'manifest missing mandatory expected_record_ids array');
  assert.deepEqual(
    [...manifest.expected_record_ids].sort(),
    [...expectedIds].sort(),
    'manifest expected_record_ids does not match Cartesian product of fixtures x viewports x styles'
  );

  // Validate rendering contract
  if (manifest.rendering_contract) {
    const allowedContractKeys = new Set(['background', 'history_simulation', 'strict_dimensions', 'require_alpha_ink', 'max_missing_glyphs', 'hash_determinism']);
    for (const key of Object.keys(manifest.rendering_contract)) {
      assert.ok(allowedContractKeys.has(key), `unknown rendering_contract property: ${key}`);
    }
    if (manifest.rendering_contract.history_simulation !== undefined) {
      assert.equal(
        manifest.rendering_contract.history_simulation,
        '120 Hz word-spring / AMLL float-clock step history starting line.lineStartTime - 1000 ms',
        'unsupported history_simulation contract'
      );
    }
  }

  // Validate fonts declarations
  if (manifest.fonts) {
    const allowedFontKeys = new Set(['skia', 'rust']);
    for (const key of Object.keys(manifest.fonts)) {
      assert.ok(allowedFontKeys.has(key), `unknown fonts property: ${key}`);
    }
    if (manifest.fonts.skia?.files) {
      for (const file of manifest.fonts.skia.files) {
        assert.ok(fs.existsSync(file), `declared skia font file not found: ${file}`);
      }
    }
  }

  return expectedIds;
}

function validateSinglePassInputs(capture, manifestPath) {
  const inv = inventory(capture);
  // Inventory closure completeness: must contain core dependencies
  assert.ok(capture.sources?.length >= 10, `incomplete sources inventory: got ${capture.sources?.length} entries (< 10 expected)`);
  for (const name of Object.keys(inv)) {
    for (const entry of inv[name]) {
      assert.ok(fs.existsSync(entry.path), `${name} input missing: ${entry.path}`);
      assert.equal(hashFile(entry.path), entry.sha256, `${name} input changed: ${entry.path}`);
    }
  }
  assert.ok(capture.records?.length, 'missing capture records');
  for (const r of capture.records) {
    assert.ok(r.inputPacket && /^[a-f0-9]{64}$/.test(r.inputPacketSha256), `missing packet file digest on ${r.id}`);
    assert.ok(fs.existsSync(r.inputPacket), `packet file missing: ${r.inputPacket}`);
    assert.equal(hashFile(r.inputPacket), r.inputPacketSha256, `packet input changed: ${r.inputPacket}`);
  }
  if (manifestPath) {
    assert.ok(fs.existsSync(manifestPath), `manifest missing: ${manifestPath}`);
    const manifestDigest = hashFile(manifestPath);
    if (capture.manifest_digest) {
      assert.equal(capture.manifest_digest, manifestDigest, 'capture manifest digest does not match on-disk manifest');
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    validateManifestSchema(manifest);

    // Validate capture records against normalized manifest contract
    const recordIds = capture.records.map(r => r.id).sort();
    const expectedIds = [...manifest.expected_record_ids].sort();
    assert.deepEqual(recordIds, expectedIds, 'capture records do not match expected manifest record IDs');

    const fixturesById = Object.fromEntries(manifest.fixtures.map(f => [f.id, f]));
    for (const r of capture.records) {
      const fId = r.fixture_id || r.id.split('-')[0];
      const fixture = fixturesById[fId];
      assert.ok(fixture, `fixture '${fId}' not found in manifest`);
      assert.equal(r.time_ms, fixture.time_ms, `time_ms mismatch against manifest on ${r.id}`);
      assert.equal(r.fixtureLine, fixture.line_index, `fixtureLine mismatch against manifest on ${r.id}`);
      assert.ok(Array.isArray(r.history_ms) && r.history_ms.length > 0, `empty or invalid history_ms on ${r.id}`);
      assert.equal(r.history_ms.at(-1), r.time_ms, `final history_ms must equal time_ms on ${r.id}`);
      assert.ok(r.settings && typeof r.settings.fontScale === 'number', `missing or invalid settings on ${r.id}`);
      assert.equal(r.settings.fontScale, 1, `unsupported fontScale on ${r.id}`);
      assert.equal(r.settings.background, false, `settings.background must be false on ${r.id}`);
      assert.ok(r.viewport && r.viewport.width > 10 && r.viewport.height > 10, `invalid viewport on ${r.id}`);
      if (r.originalSyllables) {
        const text = r.originalSyllables.map(s => s.text).join('');
        assert.equal(text, fixture.expected_text, `originalSyllables text mismatch on ${r.id}: "${text}" vs "${fixture.expected_text}"`);
      }
    }
  }
}

function validateInputs(capture, repeat, manifestPath) {
  if (manifestPath) {
    validateSinglePassInputs(capture, manifestPath);
    validateSinglePassInputs(repeat, manifestPath);
  }
  if (capture.manifest_digest || repeat.manifest_digest) {
    assert.equal(capture.manifest_digest, repeat.manifest_digest, 'independent manifest digests differ');
  }
  const first = inventory(capture), second = inventory(repeat);
  for (const name of Object.keys(first)) {
    const normalized = entries => entries.map(({ path, sha256 }) => ({ path, sha256 })).sort((a, b) => a.path.localeCompare(b.path));
    assert.deepEqual(normalized(first[name]), normalized(second[name]), `independent ${name} inputs differ`);
    for (const entry of [...first[name], ...second[name]]) {
      assert.equal(hashFile(entry.path), entry.sha256, `${name} input changed: ${entry.path}`);
    }
  }
  assert.ok(capture.records?.length && repeat.records?.length, 'missing capture records');
  assert.equal(capture.records.length, repeat.records.length, 'independent capture record counts differ');
  const packets = item => item.records.map(r => {
    assert.ok(r.inputPacket && /^[a-f0-9]{64}$/.test(r.inputPacketSha256), 'missing packet file digest');
    assert.equal(hashFile(r.inputPacket), r.inputPacketSha256, `packet input changed: ${r.inputPacket}`);
    return { id: r.id, sha256: r.inputPacketSha256 };
  }).sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(packets(capture), packets(repeat), 'independent packet inputs differ');

  // Semantic record field validation between independent passes
  const recs1 = [...capture.records].sort((a, b) => a.id.localeCompare(b.id));
  const recs2 = [...repeat.records].sort((a, b) => a.id.localeCompare(b.id));
  for (let i = 0; i < recs1.length; i++) {
    const r1 = recs1[i], r2 = recs2[i];
    assert.equal(r1.id, r2.id, `record id mismatch at ${i}`);
    if (r1.viewport !== undefined || r2.viewport !== undefined) assert.deepEqual(r1.viewport, r2.viewport, `viewport mismatch on ${r1.id}`);
    if (r1.style !== undefined || r2.style !== undefined) assert.equal(r1.style, r2.style, `style mismatch on ${r1.id}`);
    if (r1.fixtureLine !== undefined || r2.fixtureLine !== undefined) assert.equal(r1.fixtureLine, r2.fixtureLine, `fixtureLine mismatch on ${r1.id}`);
    if (r1.time_ms !== undefined || r2.time_ms !== undefined) assert.equal(r1.time_ms, r2.time_ms, `time_ms mismatch on ${r1.id}`);
    if (r1.history_ms !== undefined || r2.history_ms !== undefined) assert.deepEqual(r1.history_ms, r2.history_ms, `history_ms mismatch on ${r1.id}`);
    if (r1.settings !== undefined || r2.settings !== undefined) assert.deepEqual(r1.settings, r2.settings, `settings mismatch on ${r1.id}`);
    if (r1.skiaGeometry !== undefined || r2.skiaGeometry !== undefined) assert.deepEqual(r1.skiaGeometry, r2.skiaGeometry, `skiaGeometry mismatch on ${r1.id}`);
    if (r1.rustGeometry !== undefined || r2.rustGeometry !== undefined) assert.deepEqual(r1.rustGeometry, r2.rustGeometry, `rustGeometry mismatch on ${r1.id}`);
  }
}

module.exports = { hashFile, requireClosure, validateInputs, validateSinglePassInputs, validateManifestSchema };
