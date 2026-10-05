const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../lib/incoming-vault-share.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const loaded = { exports: {} };
new Function('module', 'exports', compiled)(loaded, loaded.exports);
const { readIncomingVaultShare, SHARE_BUILD_MESSAGE } = loaded.exports;

async function main() {
  // Reproduce a development binary without the newly configured iOS App Group.
  const oldBuild = await readIncomingVaultShare({
    getSharedPayloads() { throw new Error('Expo-sharing has failed to fetch the app group id'); },
    getResolvedSharedPayloadsAsync() { assert.fail('Must not resolve after the native getter throws'); },
  });
  assert.deepEqual(oldBuild.payloads, []);
  assert.equal(oldBuild.error.message, SHARE_BUILD_MESSAGE);
  assert.equal((await readIncomingVaultShare({})).error.message, SHARE_BUILD_MESSAGE);
  assert.equal((await readIncomingVaultShare({
    getSharedPayloads() { throw new TypeError('SharingNativeModule.getSharedPayloads is not a function'); },
    getResolvedSharedPayloadsAsync() { assert.fail('Missing native API'); },
  })).error.message, SHARE_BUILD_MESSAGE);

  const empty = await readIncomingVaultShare({
    getSharedPayloads: () => [],
    getResolvedSharedPayloadsAsync() { assert.fail('An empty inbox needs no resolution'); },
  });
  assert.deepEqual(empty, { payloads: [], error: null });

  const payload = { shareType: 'file', value: 'file:///sample.ttml', contentUri: 'file:///sample.ttml', originalName: 'sample.ttml' };
  assert.deepEqual(await readIncomingVaultShare({
    getSharedPayloads: () => [payload],
    getResolvedSharedPayloadsAsync: async () => [payload],
  }), { payloads: [payload], error: null });

  const unreadable = await readIncomingVaultShare({
    getSharedPayloads: () => [payload],
    getResolvedSharedPayloadsAsync: async () => { throw new Error('Permission denied'); },
  });
  assert.match(unreadable.error.message, /Could not read the shared file: Permission denied/);
  console.log('Vault incoming-share checks passed: missing native API, missing iOS App Group, empty inbox, shared TTML and resolution errors.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
