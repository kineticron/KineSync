/* Host regression for the physical runner's fling -> seek -> credits link ->
 * same-track AMLL replacement. This executes the preserved fixture functions,
 * production gesture contract and track preparation. No Android pixels claimed. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildSync } = require('esbuild');
const app = path.resolve(__dirname, '..');
function load(file) {
  const code = buildSync({ entryPoints: [path.join(app, file)], bundle: true, platform: 'node', format: 'cjs', write: false,
    tsconfig: path.join(app, 'tsconfig.json') }).outputFiles[0].text;
  const mod = { exports: {} };
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require, Intl });
  return mod.exports;
}
const demo = load('lib/onboarding-demo-lyrics.ts');
const { prepareRustTrack } = load('lib/rust-lyrics-preparation.ts');
const { nextVisualAnchor } = require('../lib/rust-lyrics-protocol');
const { createRustLyricsGesture } = require('../lib/rust-lyrics-gesture');
let state = {};
let following = true;
let hit = 2;
const trace = [];
const store = { getState: () => state, setState: update => { state = { ...state, ...update }; } };
const fixture = { store, performance: { now: () => 1000 }, Date, log: text => trace.push(text), module: { exports: {} },
  require: id => id === './lib/onboarding-demo-lyrics' ? demo : { startPlaybackClock() {} } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'fixtures/credits-footer-fullapp.js'), 'utf8') + '\nmodule.exports = { apply };', fixture);
const { apply } = fixture.module.exports;
const gesture = createRustLyricsGesture({ hitTest: () => hit, setFollowing: value => { following = value; },
  scrollBy() {}, fling() {}, tapEnabled: () => true, onAutoFollowChange: value => { following = value; }, onUserInteraction() {},
  onLinePress: index => store.setState({ anchorPositionMs: state.lyrics[index].lineStartTime, playbackPosition: state.lyrics[index].lineStartTime }),
  onLineLongPress() {}, onFooterPress: target => trace.push('footer target=' + target + ' following=' + following),
  setTimer: () => 1, clearTimer() {}, now: () => 1000 });
async function tap(target) { hit = target; gesture.grant(120, 100); gesture.release(); await Promise.resolve(); await Promise.resolve(); }
(async () => {
  // Runner section 40 leaves ownership manual after swipe, fling and reverse fling.
  for (const style of ['spicy', 'amll']) {
    apply(style);
    for (const dy of [-200, -350, 400]) { gesture.grant(200); gesture.move(dy); gesture.release(); }
    assert.equal(following, false, 'waiting seven seconds does not explicitly resume follow');
  }
  // Section 50 discovers and taps a real lyric row. A successful tap resumes.
  for (const style of ['spicy', 'amll']) {
    apply(style); apply('pause'); await tap(2);
    assert.equal(following, true);
    assert.equal(state.anchorPositionMs, state.lyrics[2].lineStartTime);
  }
  apply('credits');
  assert.equal(following, true);
  assert.equal(state.anchorPositionMs, 51600);
  assert.equal(state.isPlaying, false);
  const spicy = state;
  const before = nextVisualAnchor(state, 1000, 1000, 1, null);
  await tap(-3);
  assert.equal(following, false, 'maker tap takes ownership and does not resume following');
  apply('credits-amll');
  assert.equal(following, false, 'fixture does not reset player-local following');
  assert.equal(state.currentTrack.id, spicy.currentTrack.id);
  assert.equal(state.anchorPositionMs, spicy.anchorPositionMs);
  assert.notEqual(state.lyrics, spicy.lyrics, 'actual fixture replaces objects as well as style');
  const after = nextVisualAnchor(state, 1000, 36000, 1, null);
  assert.equal(before.positionMs, 51600); assert.equal(after.positionMs, 51600);
  const credits = { songwriters: Array.from(state.lyricsMetadata.credits.songwriters), attribution: {
    provider: 'FixtureProvider', community: true, maker: 'fixture-maker', maker_url: 'https://example.com/maker',
    uploader: 'fixture-uploader', uploader_url: 'https://example.com/uploader' } };
  const packets = ['spicy', 'amll'].map((style, i) => JSON.parse(prepareRustTrack(state.currentTrack.id, i + 1, state.lyrics, style, 1, false, true, credits)));
  const snapshot = path.join(app, '../native/lyrics-renderer/test/credits-switch-track.json');
  if (process.argv.includes('--write')) fs.writeFileSync(snapshot, JSON.stringify(packets) + '\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(snapshot, 'utf8')), packets, 'native regression packets match the exact fixture and current preparation');
  // Fresh track/time has no prior visual clock or gesture ownership.
  following = true; apply('credits-amll');
  assert.equal(following, true); assert.equal(state.anchorPositionMs, 51600);
  console.log(trace.join('\n'));
  console.log('Credits switch JS PASS: exact fixture at 51600ms, prior fling/seek, maker ownership, same ID/time, fresh AMLL and native packets.');
})().catch(error => { console.error(error); process.exitCode = 1; });
