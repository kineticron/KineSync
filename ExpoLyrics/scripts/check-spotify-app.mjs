import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const moduleRoot = path.join(root, 'modules/kinesync-spotify-app');

// Native sources must be tracked (the repo ignores generated android/ folders).
for (const source of [
  'expo-module.config.json',
  'android/build.gradle',
  'android/src/main/AndroidManifest.xml',
  'android/src/main/java/dev/kineticron/kinesync/spotifyapp/KineSyncSpotifyAppModule.kt',
  'android/src/main/java/dev/kineticron/kinesync/spotifyapp/SpotifyAppListenerService.kt',
]) {
  assert(fs.existsSync(path.join(moduleRoot, source)), `Missing ${source}`);
  const ignored = spawnSync('git', ['check-ignore', '--no-index', '--quiet', '--', `modules/kinesync-spotify-app/${source}`], { cwd: root });
  assert.equal(ignored.status, 1, `Native source must survive a clean checkout: ${source}`);
}
const manifest = fs.readFileSync(path.join(moduleRoot, 'android/src/main/AndroidManifest.xml'), 'utf8');
assert.match(manifest, /android\.permission\.BIND_NOTIFICATION_LISTENER_SERVICE/);
assert.match(manifest, /android\.service\.notification\.NotificationListenerService/);
const kotlin = fs.readFileSync(path.join(moduleRoot, 'android/src/main/java/dev/kineticron/kinesync/spotifyapp/KineSyncSpotifyAppModule.kt'), 'utf8');
const js = fs.readFileSync(path.join(root, 'lib/spotify-app.ts'), 'utf8');
assert.match(kotlin, /Name\("KineSyncSpotifyApp"\)/);
assert.match(js, /requireOptionalNativeModule<SpotifyAppModule>\('KineSyncSpotifyApp'\)/);
for (const name of ['hasNotificationAccess', 'openNotificationAccessSettings', 'startWatching', 'stopWatching', 'getPlayback', 'sendCommand']) {
  assert.match(kotlin, new RegExp(`Function\\("${name}"\\)`), `native ${name}`);
}
for (const key of ['active', 'hasAccess', 'title', 'artist', 'album', 'durationMs', 'positionMs', 'isPlaying', 'spotifyTrackId', 'artworkUrl', 'sampledAtMs']) {
  assert(kotlin.includes(`"${key}"`), `native snapshot has ${key}`);
}

// Run the real lib/spotify-app.ts against a fake media session and store.
const stubs = {
  'react-native': 'export const Platform = { OS: "android" };',
  expo: 'export class NativeModule {} export const requireOptionalNativeModule = () => globalThis.__native;',
  '@react-native-async-storage/async-storage': 'export default { getItem: async () => null, setItem: async () => {} };',
  '@/store/playback-store': 'export const usePlaybackStore = globalThis.__store;',
  '@/lib/lyrics-sync': 'export const refreshLyricsForCurrentTrack = (...args) => globalThis.__calls.push(["refresh", ...args]);',
  '@/lib/mobile-lyrics-client': 'export const resolveSpotifyCatalogMatch = (track) => globalThis.__catalog(track);',
};
const bundled = await build({
  entryPoints: [path.join(root, 'lib/spotify-app.ts')],
  bundle: true, format: 'esm', platform: 'node', write: false,
  plugins: [{
    name: 'stubs',
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => (args.path in stubs ? { path: args.path, namespace: 'stub' } : null));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: stubs[args.path], loader: 'js' }));
    },
  }],
});

const listeners = [];
const commands = [];
let nativePlayback = null;
let access = true;
let watchCalls = 0;
globalThis.__native = {
  hasNotificationAccess: () => access,
  openNotificationAccessSettings() {},
  startWatching: () => { watchCalls += 1; return access; },
  stopWatching() {},
  getPlayback: () => nativePlayback,
  sendCommand: (...args) => { commands.push(args); return true; },
  addListener: (_name, listener) => { listeners.push(listener); return { remove() {} }; },
};
globalThis.__calls = [];
let catalogResult = null;
globalThis.__catalog = async (track) => { globalThis.__calls.push(['catalog', track.title]); return catalogResult; };

const state = {
  playbackMode: 'mobile', connectionStatus: 'disconnected', currentTrack: null, isPlaying: false,
  anchorPositionMs: 0, anchorMonotonicMs: 0,
};
const packets = [];
state.ingestPacket = (packet, source) => {
  assert.equal(source, 'mobile');
  packets.push(packet);
  const trackChanged = state.currentTrack?.id !== packet.trackId;
  state.currentTrack = {
    id: packet.trackId, title: packet.title, artist: packet.artist, album: packet.album,
    durationMs: packet.durationMs, spotifyTrackId: packet.spotifyTrackId,
    artworkUrl: 'artworkUrl' in packet ? packet.artworkUrl : state.currentTrack?.artworkUrl,
  };
  state.isPlaying = packet.isPlaying;
  state.anchorPositionMs = packet.positionMs;
  return { trackChanged, seekDetected: false };
};
state.clearLyrics = () => globalThis.__calls.push(['clear']);
state.setLyricsStatusMessage = (message) => globalThis.__calls.push(['status', message]);
globalThis.__store = { getState: () => state };

const lib = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const emit = (playback) => listeners.forEach((listener) => listener(playback));
const song = {
  active: true, hasAccess: true, title: 'Obsession', artist: 'EXO', album: 'Obsession - The 6th Album',
  durationMs: 203520, positionMs: 33738, isPlaying: true, spotifyTrackId: '7fK0csBoqbcgUuWGV0cpoD',
  artworkUrl: '', sampledAtMs: 1_000,
};

// A valid token and a Spotify ID: no catalog lookup, lyrics load immediately.
lib.usePhonePlaybackSource.getState().setSource('spotify-app');
assert.equal(lib.isFollowingSpotifyApp(), true);
nativePlayback = song;
const stop = lib.startSpotifyAppTracking(() => true);
await flush();
assert.equal(packets.length, 1, 'initial Spotify state is ingested');
assert.equal(packets[0].trackId, 'spotify-app:obsession:exo');
assert.equal(packets[0].spotifyTrackId, '7fK0csBoqbcgUuWGV0cpoD');
assert.equal(packets[0].positionMs, 33738);
assert.equal(packets[0].capturedAtMs, 1_000);
assert.equal(packets[0].artworkUrl, '', 'a new song clears the previous cover');
assert.deepEqual(globalThis.__calls.map((call) => call[0]), ['clear', 'status', 'refresh']);
assert.equal(globalThis.__calls.at(-1)[1], 'auto');

// Same song: a position update must not clear lyrics or the resolved cover.
globalThis.__calls.length = 0;
state.currentTrack.artworkUrl = 'https://resolved.example/cover.jpg';
emit({ ...song, positionMs: 60_000, sampledAtMs: 2_000 });
await flush();
assert.equal(packets.length, 2);
assert.equal('artworkUrl' in packets[1], false, 'no empty artwork field for the same song');
assert.equal(state.currentTrack.artworkUrl, 'https://resolved.example/cover.jpg');
assert.deepEqual(globalThis.__calls, [], 'no lyrics reload for the same song');

// Spotify stops: keep the song, paused.
emit({ active: false, hasAccess: true });
await flush();
assert.equal(packets.at(-1).isPlaying, false);
assert.equal(packets.at(-1).trackId, 'spotify-app:obsession:exo');

// A new song without a Spotify ID: catalog identity first, then lyrics.
globalThis.__calls.length = 0;
catalogResult = { spotifyTrackId: '4uLU6hMCjMI75M1A2tKUQC', artist: 'Rick Astley', album: 'Whenever You Need Somebody', durationMs: 213573 };
emit({ ...song, title: 'Never Gonna Give You Up', artist: 'Rick Astley', album: '', spotifyTrackId: '', positionMs: 0, sampledAtMs: 3_000 });
await flush();
assert.deepEqual(globalThis.__calls.map((call) => call[0]), ['clear', 'status', 'catalog', 'refresh']);
assert.equal(packets.at(-1).spotifyTrackId, '4uLU6hMCjMI75M1A2tKUQC', 're-emitted with the catalog Spotify ID');
assert.equal(packets.at(-1).album, 'Whenever You Need Somebody');
assert.equal(packets.at(-1).trackId, 'spotify-app:never gonna give you up:rick astley', 'same identity, not a track change');

// Bridge mode or a connected bridge owns playback: ignore Spotify app events.
const before = packets.length;
state.playbackMode = 'desktop';
emit({ ...song, positionMs: 1 });
state.playbackMode = 'mobile';
state.connectionStatus = 'connected';
emit({ ...song, positionMs: 1 });
state.connectionStatus = 'disconnected';
assert.equal(packets.length, before);

// Controls go to the Spotify app's media session.
lib.spotifyAppControls.togglePlayPause();
lib.spotifyAppControls.skipNext();
lib.spotifyAppControls.skipPrevious();
lib.spotifyAppControls.seekTo(-5);
lib.spotifyAppControls.seekTo(42_000);
assert.deepEqual(commands, [['toggle'], ['next'], ['previous'], ['seek', 0], ['seek', 42000]]);

stop();

// Not signed in to Spotify: a song whose Spotify ID is in the media session
// loads lyrics at once instead of waiting for a web token.
globalThis.__calls.length = 0;
nativePlayback = { ...song, title: 'Growl', positionMs: 0, sampledAtMs: 5_000 };
const stopSignedOut = lib.startSpotifyAppTracking(() => false);
await flush();
assert.deepEqual(globalThis.__calls.map((call) => call[0]), ['clear', 'status', 'refresh'], 'no token wait when Spotify shares the track ID');
stopSignedOut();

// Notification access granted while KineSync is open: coming back to the app
// starts watching Spotify again, no restart needed.
access = false;
nativePlayback = null;
const stopNoAccess = lib.startSpotifyAppTracking(() => true);
assert.equal(lib.usePhonePlaybackSource.getState().notificationAccess, false);
access = true;
const watchesBefore = watchCalls;
nativePlayback = { ...song, title: 'After Access', sampledAtMs: 7_000 };
lib.resyncSpotifyApp(() => true);
await flush();
assert.equal(watchCalls, watchesBefore + 1, 'returning to the app starts watching again');
assert.equal(lib.usePhonePlaybackSource.getState().notificationAccess, true);
assert.equal(packets.at(-1).title, 'After Access', 'Spotify playback is picked up straight away');
stopNoAccess();
console.log('Spotify app source checks passed.');
