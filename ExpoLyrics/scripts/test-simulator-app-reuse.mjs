import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { digest, treeManifest, writeJson, nativeIdentity, mayShareNative, validateNativeCache, saveNativeCache,
  materializeVariantResources, verifyVariantApp, verifyRuntimeProvenance, buildVariantPair } from './simulator-app-reuse.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-reuse-'));
const file = (name, data) => { fs.mkdirSync(path.dirname(name), { recursive: true }); fs.writeFileSync(name, data); };
const a = { eligible: true, key: digest('native-A') }, b = { eligible: true, key: digest('native-B') };
try {
  for (const [candidate, expected] of [[a, 1], [b, 2], [{ eligible: false, key: a.key }, 2], [null, 2]]) {
    let builds = 0, bundles = 0, assemblies = 0, stopped = 0;
    const variants = { baseline: { variant: 'baseline', identity: a }, candidate: { variant: 'candidate', identity: candidate } };
    await buildVariantPair(variants, {
      exportBundle: () => { bundles++; return { finish: async () => {}, stop: () => { stopped++; } }; },
      buildNative: () => { builds++; return {}; }, assemble: () => { assemblies++; },
    });
    assert.equal(builds, expected); assert.equal(bundles, 2); assert.equal(assemblies, 2); assert.equal(stopped, 1);
  }
  let assembled = false, stopped = false;
  await assert.rejects(buildVariantPair({ baseline: { identity: a }, candidate: { identity: a } }, {
    exportBundle: () => ({ finish: async () => { throw new Error('export failed'); }, stop: () => { stopped = true; } }),
    buildNative: () => ({}), assemble: () => { assembled = true; },
  }), /export failed/);
  assert.equal(assembled, false); assert.equal(stopped, true);
  await assert.rejects(buildVariantPair({ baseline: { identity: a }, candidate: { identity: a } }, {
    exportBundle: () => ({ finish: async () => {}, stop: () => {} }),
    buildNative: () => { throw new Error('native failed'); }, assemble: () => { assembled = true; },
  }), /native failed/);
  assert.equal(assembled, false);
  assert.equal(mayShareNative({ eligible: true, key: '' }, { eligible: true, key: '' }), false);
  const project = path.join(root, 'missing-fingerprint'); file(path.join(project, 'package.json'), '{}');
  const failed = await nativeIdentity(project, {});
  assert.equal(failed.eligible, false); assert.equal(mayShareNative(failed, failed), false);
  const native = path.join(root, 'native.app'), compiler = path.join(root, 'hermesc'), cache = path.join(root, 'cache');
  file(path.join(native, 'KineSync'), 'arm64 native'); file(path.join(native, 'Info.plist'), 'native config'); file(compiler, 'matching compiler');
  saveNativeCache(cache, a, native, compiler);
  assert.equal(validateNativeCache(cache, a), true);
  assert.equal(validateNativeCache(cache, b), false);
  assert.equal(validateNativeCache(cache, { eligible: false, key: a.key }), false);
  file(path.join(cache, 'payload/hermesc'), 'corrupt'); assert.equal(validateNativeCache(cache, a), false);
  saveNativeCache(cache, a, native, compiler);
  file(path.join(cache, 'payload/KineSync.app/main.jsbundle'), 'stale JS'); assert.equal(validateNativeCache(cache, a), false);
  saveNativeCache(cache, a, native, compiler);
  fs.unlinkSync(path.join(cache, 'payload/KineSync.app/KineSync')); assert.equal(validateNativeCache(cache, a), false);
  file(path.join(native, 'main.jsbundle'), 'must not cache'); assert.throws(() => saveNativeCache(cache, a, native, compiler), /Refusing to cache JS/);
  fs.unlinkSync(path.join(native, 'main.jsbundle'));
  const bundle = path.join(root, 'fresh'), app = path.join(root, 'assembled.app');
  file(path.join(bundle, 'main.jsbundle'), 'fresh JS'); file(path.join(bundle, 'assets/new.png'), 'new image');
  file(path.join(app, 'assets/removed.png'), 'stale image'); file(path.join(app, 'main.jsbundle'), 'stale JS');
  materializeVariantResources(native, app, bundle);
  assert.equal(fs.existsSync(path.join(app, 'assets/removed.png')), false);
  assert.equal(fs.readFileSync(path.join(app, 'assets/new.png'), 'utf8'), 'new image');
  assert.equal(fs.existsSync(path.join(app, 'main.jsbundle')), false, 'Only separately compiled fresh Hermes output may fill this slot');
  file(path.join(bundle, 'Info.plist'), 'native collision');
  assert.throws(() => materializeVariantResources(native, app, bundle), /collides/); fs.unlinkSync(path.join(bundle, 'Info.plist'));
  materializeVariantResources(native, app, bundle);
  file(path.join(app, 'main.jsbundle'), 'fresh Hermes');
  const expected = { sourceSha: 'a'.repeat(40), harnessSha: 'b'.repeat(40), variant: 'baseline' };
  const provenance = { ...expected, identity: { ...expected, env: { EXPO_PUBLIC_SIMULATOR_TEST: '1' } }, files: treeManifest(app) };
  provenance.runtimeId = digest(provenance.identity); writeJson(path.join(app, 'ci-provenance.json'), provenance);
  assert.equal(verifyVariantApp(app, expected).runtimeId, provenance.runtimeId);
  assert.throws(() => verifyVariantApp(app, { ...expected, sourceSha: 'c'.repeat(40) }), /mismatch/);
  assert.throws(() => verifyVariantApp(app, { ...expected, harnessSha: 'c'.repeat(40) }), /mismatch/);
  assert.throws(() => verifyVariantApp(app, { ...expected, variant: 'candidate' }), /mismatch/);
  assert.throws(() => verifyRuntimeProvenance(provenance, undefined), /runtime/);
  assert.throws(() => verifyRuntimeProvenance(provenance, digest('wrong bundle')), /runtime/);
  assert.equal(verifyRuntimeProvenance(provenance, provenance.runtimeId).bundleHash, provenance.files['main.jsbundle'].hash);
  for (const name of ['main.jsbundle', 'assets/new.png', 'KineSync']) {
    const original = fs.readFileSync(path.join(app, name)); file(path.join(app, name), 'corrupt');
    assert.throws(() => verifyVariantApp(app, expected), /hash mismatch/); file(path.join(app, name), original);
  }
  file(path.join(app, 'assets/stale.png'), 'unexpected'); assert.throws(() => verifyVariantApp(app, expected), /hash mismatch/);
  fs.unlinkSync(path.join(app, 'assets/stale.png'));
  provenance.identity.sourceSha = 'f'.repeat(40); writeJson(path.join(app, 'ci-provenance.json'), provenance);
  assert.throws(() => verifyVariantApp(app, expected), /runtime identity/);
  file(path.join(root, 'outside'), 'escape'); fs.symlinkSync(path.join(root, 'outside'), path.join(app, 'escape'));
  assert.throws(() => treeManifest(app), /Escaping symlink/);
  console.log('Native equality/fallback, cache corruption, fresh assets and runtime provenance tests passed.');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
