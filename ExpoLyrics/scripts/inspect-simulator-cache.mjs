// Read-only cache validation before work; bounded publication decisions after work.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson, nativeCacheState, directoryBytes, MAX_NATIVE_CACHE_BYTES, MAX_COMPILER_CACHE_BYTES } from './simulator-app-reuse.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const state = path.join(root, 'ExpoLyrics/.expo/pair');
const { variants } = readJson(path.join(state, 'plan.json'));
const mode = process.argv[2];
if (!['before', 'after'].includes(mode)) throw new Error('Expected cache inspection mode before or after');
const before = mode === 'after' ? readJson(path.join(state, 'cache-before.json')) : null;
const entries = Object.fromEntries(Object.entries(variants).map(([variant, v]) =>
  [variant, nativeCacheState(path.resolve(root, '../kinesync-native-cache'), v.identity, before?.entries[variant]?.valid)]));
const needsNative = Object.values(entries).some(entry => !entry.valid);
const compilerBytes = directoryBytes(path.resolve(root, '../kinesync-ios-ccache'));
const evidence = { mode, limits: { nativeEntryBytes: MAX_NATIVE_CACHE_BYTES, compilerBytes: MAX_COMPILER_CACHE_BYTES }, entries, compilerBytes,
  persistedPaths: ['verified native entry per identity', 'bounded ccache only'],
  excludedFromPersistence: ['Pods', 'DerivedData', 'CocoaPods downloads'] };
writeJson(path.join(state, `cache-${mode}.json`), evidence);
console.log(JSON.stringify(evidence));
if (mode === 'before') fs.appendFileSync(process.env.GITHUB_OUTPUT, `needs_native=${needsNative}\n`);
else {
  const shared = variants.baseline.identity.key && variants.baseline.identity.key === variants.candidate.identity.key;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `baseline_save=${entries.baseline.save}\ncandidate_save=${entries.candidate.save && !shared}\ncompiler_save=${Object.values(before.entries).some(entry => !entry.valid) && compilerBytes > 0 && compilerBytes <= MAX_COMPILER_CACHE_BYTES}\n`);
}
