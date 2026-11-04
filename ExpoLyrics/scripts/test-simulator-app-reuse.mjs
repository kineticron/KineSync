import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { digest, treeManifest, writeJson, nativeIdentity, mayShareNative, validateNativeCache, saveNativeCache,
  materializeVariantResources, saveInstalledAppEvidence, verifyVariantApp, verifyRuntimeProvenance, buildVariantPair, nativeCacheToken, nativeCacheState, directoryBytes, resolveHermesCompiler, hermesCompileArguments } from './simulator-app-reuse.mjs';
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
  const events = [];
  await buildVariantPair({ baseline: { variant: 'baseline', identity: a }, candidate: { variant: 'candidate', identity: b } }, {
    buildNative: v => { events.push(`build:${v.variant}`); return {}; },
    exportBundle: v => { events.push(`export:${v.variant}`); return { finish: async () => events.push(`finish:${v.variant}`), stop() {} }; },
    assemble: v => events.push(`assemble:${v.variant}`),
  });
  assert.deepEqual(events, ['build:baseline', 'export:baseline', 'build:candidate', 'finish:baseline', 'assemble:baseline', 'export:candidate', 'finish:candidate', 'assemble:candidate'], 'Never mutate a tree while its Metro export crawls it; only the other tree may build');
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
  // An unchanged baseline uses its own token even when the candidate native identity changes.
  assert.equal(nativeCacheToken(a), a.key);
  assert.equal(nativeCacheToken({ ...a, eligible: false }), null);
  const keyedRoot = path.join(root, 'per-native'), keyedEntry = path.join(keyedRoot, a.key);
  saveNativeCache(keyedEntry, a, native, compiler);
  const measured = nativeCacheState(keyedRoot, a);
  assert.equal(measured.bytes, directoryBytes(keyedEntry));
  assert.ok(measured.bytes > 0);
  assert.equal(measured.save, true);
  assert.equal(nativeCacheState(keyedRoot, a, true).save, false, 'Warm hits must not upload a duplicate immutable snapshot');
  assert.equal(nativeCacheState(keyedRoot, a, false, measured.bytes - 1).save, false, 'Oversize entries stay usable but are not persisted');
  assert.equal(nativeCacheState(keyedRoot, b).valid, false);
  assert.equal(nativeCacheState(keyedRoot, a).valid, true, 'Changing candidate cannot prevent baseline retrieval');
  file(path.join(keyedEntry, 'payload/hermesc'), 'damaged');
  assert.equal(nativeCacheState(keyedRoot, a).save, false);

  assert.equal(validateNativeCache(cache, b), false);
  assert.equal(validateNativeCache(cache, { eligible: false, key: a.key }), false);
  file(path.join(cache, 'payload/hermesc'), 'corrupt'); assert.equal(validateNativeCache(cache, a), false);
  saveNativeCache(cache, a, native, compiler);
  file(path.join(cache, 'payload/KineSync.app/main.jsbundle'), 'stale JS'); assert.equal(validateNativeCache(cache, a), false);
  saveNativeCache(cache, a, native, compiler);
  fs.unlinkSync(path.join(cache, 'payload/KineSync.app/KineSync')); assert.equal(validateNativeCache(cache, a), false);
  file(path.join(native, 'main.jsbundle'), 'must not cache'); assert.throws(() => saveNativeCache(cache, a, native, compiler), /Refusing to cache JS/);
  fs.unlinkSync(path.join(native, 'main.jsbundle'));
  const ios = path.join(root, 'ios'), pods = path.join(ios, 'Pods');
  for (const relative of ['hermes-engine/destroot/bin/hermesc', 'hermes-engine/build_host_hermesc/bin/hermesc']) {
    const actualCompiler = path.join(pods, relative); file(actualCompiler, 'matching VM compiler'); fs.chmodSync(actualCompiler, 0o755);
    const settings = { PODS_ROOT: pods, HERMES_CLI_PATH: '${PODS_ROOT}/' + relative };
    assert.equal(resolveHermesCompiler(settings, ios), actualCompiler);
  }
  const podSelectedNpm = path.join(root, 'node_modules/hermes-compiler/hermesc/osx-bin/hermesc');
  file(podSelectedNpm, 'Pod-selected compiler'); fs.chmodSync(podSelectedNpm, 0o755);
  assert.equal(resolveHermesCompiler({ PODS_ROOT: pods, HERMES_CLI_PATH: '$(PODS_ROOT)/../../node_modules/hermes-compiler/hermesc/osx-bin/hermesc' }, ios), podSelectedNpm);
  assert.throws(() => resolveHermesCompiler({ PODS_ROOT: pods, HERMES_CLI_PATH: '$(PODS_ROOT)/missing/bin/hermesc' }, ios), /Matching Hermes compiler missing/, 'Never substitute an existing default for a missing effective compiler');
  assert.throws(() => resolveHermesCompiler({ HERMES_CLI_PATH: '$(UNKNOWN)/hermesc' }, ios), /Unresolved/);
  fs.chmodSync(podSelectedNpm, 0o644);
  assert.throws(() => resolveHermesCompiler({ HERMES_CLI_PATH: podSelectedNpm }, ios), /not executable/);
  if (process.platform === 'linux') {
    const require = createRequire(import.meta.url);
    const actualCompiler = path.join(path.dirname(require.resolve('hermes-compiler/package.json')), 'hermesc/linux64-bin/hermesc');
    const raw = path.join(root, 'actual-provenance.js'), bytecode = path.join(root, 'actual-provenance.hbc');
    file(raw, "console.info('[KINESYNC_PROVENANCE] compiler regression');");
    execFileSync(actualCompiler, hermesCompileArguments(raw, bytecode));
    assert.ok(fs.statSync(bytecode).size > 0, 'Actual shipped compiler accepts Release -O/-w invocation and produces bytecode');
  }
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
  // Evidence never authorizes a changed tree: each mutation still reaches the
  // original strict verifier, with exact observed values already on disk.
  const signed = path.join(root, 'signed.app'), installed = path.join(root, 'installed.app');
  fs.cpSync(app, signed, { recursive: true, verbatimSymlinks: true });
  fs.symlinkSync('KineSync', path.join(signed, 'native-link'));
  const signedProvenance = { ...provenance, files: treeManifest(signed) };
  delete signedProvenance.files['ci-provenance.json'];
  writeJson(path.join(signed, 'ci-provenance.json'), signedProvenance);
  const evidence = path.join(root, 'installed-evidence');
  const loadEvidence = name => JSON.parse(fs.readFileSync(path.join(evidence, name), 'utf8'));
  const mutations = [
    ['hash', () => file(path.join(installed, 'main.jsbundle'), 'changed bytes'), 'main.jsbundle', 'changed'],
    ['mode', () => fs.chmodSync(path.join(installed, 'KineSync'), signedProvenance.files.KineSync.mode ^ 0o111), 'KineSync', 'changed'],
    ['added', () => file(path.join(installed, 'new/path'), 'new file'), 'new/path', 'added'],
    ['missing', () => fs.unlinkSync(path.join(installed, 'assets/new.png')), 'assets/new.png', 'missing'],
    ['link', () => { fs.unlinkSync(path.join(installed, 'native-link')); fs.symlinkSync('main.jsbundle', path.join(installed, 'native-link')); }, 'native-link', 'changed'],
    ['type', () => { fs.unlinkSync(path.join(installed, 'native-link')); file(path.join(installed, 'native-link'), 'now a file'); }, 'native-link', 'changed'],
  ];
  for (const [kind, mutate, changedPath, status] of [['success', () => {}], ...mutations]) {
    fs.rmSync(installed, { recursive: true, force: true });
    fs.cpSync(signed, installed, { recursive: true, verbatimSymlinks: true });
    mutate();
    const observed = treeManifest(installed); delete observed['ci-provenance.json'];
    const originalExpected = JSON.stringify(signedProvenance);
    saveInstalledAppEvidence(installed, signedProvenance, evidence);
    assert.equal(JSON.stringify(signedProvenance), originalExpected, 'Evidence must not mutate expected provenance');
    assert.deepEqual(loadEvidence('installed-app-hashes.json'), { installed, files: observed });
    assert.deepEqual(loadEvidence('installed-app-diff.json'), { installed, differences: kind === 'success' ? [] : [{
      path: changedPath, status, expected: signedProvenance.files[changedPath] ?? null, actual: observed[changedPath] ?? null,
    }] });
    if (kind === 'success') assert.equal(verifyVariantApp(installed, expected, signedProvenance), signedProvenance);
    else assert.throws(() => verifyVariantApp(installed, expected, signedProvenance), { message: 'App bundle/assets/native hash mismatch' });
  }
  saveInstalledAppEvidence(signed, signedProvenance, evidence);
  assert.throws(() => verifyVariantApp(signed, { ...expected, variant: 'candidate' }, signedProvenance), { message: 'App provenance mismatch: variant' });
  assert.deepEqual(loadEvidence('installed-app-diff.json').differences, []);
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
