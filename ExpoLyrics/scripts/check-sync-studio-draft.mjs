// Sync Studio drafts: up to five songs in progress, each finished edit is
// written once (never during a slide), and the latest edit always wins.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundled = await build({
  entryPoints: [path.join(root, 'lib/sync-studio/storage.ts')], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
  plugins: [{ name: 'storage', setup(b) {
    b.onResolve({ filter: /^@react-native-async-storage\/async-storage$/ }, () => ({ path: 'mem', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default globalThis.__storage;', loader: 'js' }));
  } }],
});
const data = new Map();
let writes = 0;
globalThis.__storage = {
  getItem: async (key) => data.get(key) ?? null,
  setItem: async (key, value) => { writes += 1; data.set(key, value); },
  removeItem: async (key) => { data.delete(key); },
};
const storage = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const project = (n, id) => ({ version: 1, ...(id ? { id } : {}), title: `v${n}`, artist: 'a', lines: [{ id: 'x', words: [], start: n, end: null, background: false }], updatedAt: n });

// The older single draft is carried over into the list once.
data.set('kinesync_sync_studio_draft_v1', JSON.stringify(project(0)));
const carried = await storage.loadSyncStudioDrafts();
assert.equal(carried.length, 1);
assert.equal(carried[0].title, 'v0');
assert.ok(carried[0].id, 'carried-over drafts get an id');
assert.equal(data.has('kinesync_sync_studio_draft_v1'), false);
const legacyId = carried[0].id;

// Up to five songs, newest first; the oldest drops off.
writes = 0;
for (let n = 1; n <= 5; n++) await storage.saveSyncStudioDraft(project(n, `song${n}`));
assert.equal(writes, 5, 'one write per finished edit');
let list = await storage.loadSyncStudioDrafts();
assert.deepEqual(list.map((d) => d.title), ['v5', 'v4', 'v3', 'v2', 'v1'], 'five kept; the carried-over draft was the oldest');
assert.equal(list.some((d) => d.id === legacyId), false);

// Editing a song updates its entry and moves it to the top, never duplicating it.
await storage.saveSyncStudioDraft({ ...project(2, 'song2'), title: 'v2 edited' });
list = await storage.loadSyncStudioDrafts();
assert.deepEqual(list.map((d) => d.title), ['v2 edited', 'v5', 'v4', 'v3', 'v1']);
assert.deepEqual(JSON.parse(data.get('kinesync_sync_studio_drafts_v2')).map((d) => d.title), list.map((d) => d.title), 'the device copy matches');

// A new project without an id gets one, so its later edits stay one entry.
const fresh = storage.withDraftId(project(9));
await storage.saveSyncStudioDraft(fresh);
await storage.saveSyncStudioDraft({ ...fresh, title: 'v9 again' });
list = await storage.loadSyncStudioDrafts();
assert.equal(list.filter((d) => d.id === fresh.id).length, 1);
assert.equal(list.length, 5);

await storage.discardSyncStudioDraft('song5');
assert.equal((await storage.loadSyncStudioDrafts()).some((d) => d.id === 'song5'), false, 'discarding removes that draft only');
assert.equal((await storage.loadSyncStudioDrafts()).length, 4);

const settings = await storage.loadSyncStudioSettings();
assert.equal(settings.leadInMs, 1000);
data.set('kinesync_sync_studio_settings_v1', JSON.stringify({ leadInMs: 6000 }));
assert.equal((await storage.loadSyncStudioSettings()).leadInMs, 2000, 'old lead-in values fit the 0–2 s slider');
assert.equal((await storage.loadSyncStudioSettings()).syllableLanguage, 'en');
data.set('kinesync_sync_studio_settings_v1', JSON.stringify({ syllableLanguage: 'pa' }));
assert.equal((await storage.loadSyncStudioSettings()).syllableLanguage, 'pa', 'the syllable language is remembered');
data.set('kinesync_sync_studio_settings_v1', JSON.stringify({ syllableLanguage: 'xx' }));
assert.equal((await storage.loadSyncStudioSettings()).syllableLanguage, 'en');

console.log('Sync Studio draft checks passed: up to five songs, newest first, one entry per song, carried-over draft, one write per edit, lead-in clamped, syllable language kept.');
