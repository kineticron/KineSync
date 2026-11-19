import assert from 'node:assert/strict';
import { verifyCache } from './verify-ci-cache.mjs';
const base = { key: 'unique-run-key', ref: 'refs/heads/ci-sim', repository: 'owner/repo', token: 'test-only' };
const record = { key: base.key, ref: base.ref, id: 42, size_in_bytes: 4096 };
const request = entries => async (url, options) => {
  assert.equal(url.searchParams.get('key'), base.key);
  assert.equal(url.searchParams.get('ref'), base.ref);
  assert.equal(options.redirect, 'error');
  return { ok: true, json: async () => ({ actions_caches: entries }) };
};
assert.deepEqual(await verifyCache({ ...base, request: request([record]) }), { key: base.key, ref: base.ref, id: 42, sizeInBytes: 4096, verified: true });
for (const bad of [[], [{ ...record, key: 'prefix-only' }], [{ ...record, ref: 'refs/heads/main' }], [{ ...record, size_in_bytes: 0 }], [{ ...record, id: null }]]) {
  await assert.rejects(verifyCache({ ...base, request: request(bad) }), /NOT confirmed/);
}
await assert.rejects(verifyCache({ ...base, request: async () => ({ ok: false, status: 403 }) }), /HTTP 403/);
await assert.rejects(verifyCache({ ...base, key: '', request: request([]) }), /Missing/);
console.log('Cache server-verification regression tests passed.');

let pages = [];
await verifyCache({ ...base, request: async (url) => {
  const page = Number(url.searchParams.get('page')); pages.push(page);
  return { ok: true, json: async () => ({ actions_caches: page === 1 ? Array.from({ length: 100 }, () => ({ ...record, key: 'prefix-only' })) : [record] }) };
} });
assert.deepEqual(pages, [1, 2]);
let attempts = 0;
await verifyCache({ ...base, request: async () => ({ ok: true, json: async () => ({ actions_caches: ++attempts === 3 ? [record] : [] }) }) });
assert.equal(attempts, 3, 'Allow bounded cache visibility delay');
