// TEST-ONLY entry (full-app FTL test). Runs the real expo-router app with seeded stores.
// Fixture states via deep link expolyrics://?fx=<state>. Not part of production.
const RN = require('react-native');
const React = require('react');
const AsyncStorage = require('@react-native-async-storage/async-storage').default;
const log = (m) => console.info('KSFX ' + m);
try { RN.LogBox.ignoreAllLogs(true); } catch (e) {}
let surface = null;
let armed = null;
RN.Linking.openURL = (url) => {
  log('LINK_OPEN ' + url);
  if (armed && armed.kind === 'link' && armed.url === url && store.getState().currentTrack.id === armed.track) {
    log('LINK_OK request=' + armed.request + ' url=' + url);
    armed = null;
  }
  return Promise.resolve(true);
};
// Test-only wrapper around the actual native surface. Hit testing discovers a
// target without invoking its handler. The runner still sends a real input tap.
// Patch the defining exports, since the public barrel uses read-only getters.
// Cover Metro's expo-source condition and the compiled package entry.
const adapters = [
  require('../../node_modules/expo-modules-core/src/NativeViewManagerAdapter'),
  require('../../node_modules/expo-modules-core/build/NativeViewManagerAdapter'),
];
for (const adapter of adapters) {
const originalManager = adapter.requireNativeViewManager;
adapter.requireNativeViewManager = (name, ...args) => {
  const Native = originalManager(name, ...args);
  if (name !== 'KineSyncRustLyrics') return Native;
  return React.forwardRef(function MeasuredLyrics(props, forwarded) {
    const box = React.useRef(null);
    const attach = React.useCallback(view => {
      if (typeof forwarded === 'function') forwarded(view);
      else if (forwarded) forwarded.current = view;
      if (view) surface = { view, box };
      else if (surface && surface.box === box) surface = null;
    }, [forwarded]);
    return React.createElement(RN.View, { ref: box, style: props.style, collapsable: false },
      React.createElement(Native, { ...props, style: { flex: 1 }, ref: attach }));
  });
};
}
async function probe(kind, request) {
  armed = null;
  const current = surface;
  if (!current || !current.box.current || !/^[a-zA-Z0-9-]+$/.test(request)) { log('TARGET_MISSING request=' + request); return; }
  const state = store.getState();
  const track = state.currentTrack.id;
  const bounds = await new Promise(resolve => current.box.current.measureInWindow((x, y, width, height) => resolve({ x, y, width, height })));
  // Hit-test logical coordinates inside the measured canvas. Screen taps use
  // physical pixels, including the current orientation and window offset.
  for (let y = 12; y < bounds.height - 12; y += 12) {
    for (const fraction of [0.5, 0.25, 0.75]) {
      const x = bounds.width * fraction;
      const index = await current.view.hitTest(x, y);
      const line = state.lyrics[index];
      const seek = kind === 'seek' && index > 0 && line && Math.abs(line.lineStartTime - state.anchorPositionMs) > 900;
      const link = kind === 'link' && index === -3 && state.lyricsMetadata.attribution?.maker?.url;
      if (!seek && !link) continue;
      if (surface !== current || store.getState().currentTrack.id !== track) break;
      const expected = seek ? line.lineStartTime : -3;
      const url = link ? state.lyricsMetadata.attribution.maker.url : '';
      armed = { kind, request, expected, url, track };
      const ratio = RN.PixelRatio.get();
      log('TARGET request=' + request + ' x=' + Math.round((bounds.x + x) * ratio) + ' y=' + Math.round((bounds.y + y) * ratio) + ' expected=' + expected + ' url=' + url);
      return;
    }
  }
  log('TARGET_MISSING request=' + request + ' bounds=' + JSON.stringify(bounds));
}
const seed = AsyncStorage.multiSet([
  ['kinesync_onboarding_completed', 'true'],
  ['kinesync_bridge_settings', JSON.stringify({ serverUrl: '', handshakeKey: '', playbackMode: 'desktop', onboardingCompleted: true })],
  ['kinesync_use_rust_renderer', 'true'],
  ['kinesync_tour_completed', 'true'],
]);
let ready = false; let pending = null; let store = null;
function lines(kind) {
  const { DEMO_LYRICS } = require('../../lib/onboarding-demo-lyrics');
  if (kind === 'cjk') {
    const t = [['안녕하세요 우리 함께 노래해요', 'Hello let us sing together'], ['夜空に光る星を数えて', 'Counting the stars in the night sky'], ['달빛 아래 춤을 춰요', 'Dance under the moonlight'], ['ありがとう また会いましょう', 'Thank you, see you again']];
    return t.map(([text, tr], i) => { const s = i * 5000; const w = text.split(' '); return { lineStartTime: s, lineEndTime: s + 4600, translatedText: tr, oppositeAligned: i % 2 === 1, syllables: w.map((x, j) => ({ text: x + (j < w.length - 1 ? ' ' : ''), startTime: s + j * 900, endTime: s + (j + 1) * 900 })) }; });
  }
  const out = [];
  for (let k = 0; k < 2; k++) DEMO_LYRICS.forEach((l) => { const o = k * 25000; out.push({ ...l, lineStartTime: l.lineStartTime + o, lineEndTime: l.lineEndTime + o, syllables: l.syllables.map((s) => ({ ...s, startTime: s.startTime + o, endTime: s.endTime + o })), backgroundSyllables: l.backgroundSyllables && l.backgroundSyllables.map((s) => ({ ...s, startTime: s.startTime + o, endTime: s.endTime + o })) }); });
  return out;
}
function afterEnd(ls) { const end = Math.max(...ls.map((l) => l.lineEndTime)) + 2000; return { isPlaying: false, anchorPositionMs: end, playbackPosition: end, currentTrack: { id: 'fx-track-credits', title: 'Fixture credits', artist: 'KineSync Test', durationMs: end + 8000 } }; }
function apply(fx) {
  armed = null;
  const nowMono = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const track = { id: 'fx-track-' + fx, title: 'Fixture ' + fx, artist: 'KineSync Test', durationMs: 60000 };
  const base = { currentTrack: track, playbackMode: 'desktop', connectionStatus: 'connected', useRustRenderer: true, isPlaying: true, anchorPositionMs: 3000, anchorTimestampMs: Date.now(), anchorMonotonicMs: nowMono, playbackPosition: 3000, lyricsStatusMessage: '', lyricsSource: 'fixture' };
  const credits = { credits: { songwriters: ['Fixture Writer One', 'Fixture Writer Two'] }, attribution: { source: 'fixture', provider: 'FixtureProvider', community: true, maker: { username: 'fixture-maker', url: 'https://example.com/maker' }, uploader: { username: 'fixture-uploader', url: 'https://example.com/uploader' } } };
  let s;
  if (fx === 'amll') s = { lyrics: lines(), lyricsStyle: 'amll', lyricsMetadata: {} };
  else if (fx === 'spicy') s = { lyrics: lines(), lyricsStyle: 'spicy', lyricsMetadata: {} };
  else if (fx === 'credits') s = { lyrics: lines(), lyricsStyle: 'spicy', lyricsMetadata: credits, ...afterEnd(lines()) };
  else if (fx === 'credits-amll') s = { lyrics: lines(), lyricsStyle: 'amll', lyricsMetadata: credits, ...afterEnd(lines()) };
  else if (fx === 'cjk') s = { lyrics: lines('cjk'), lyricsStyle: 'spicy', lyricsMetadata: {} };
  else if (fx === 'cjk-amll') s = { lyrics: lines('cjk'), lyricsStyle: 'amll', lyricsMetadata: {} };
  else if (fx === 'loading') s = { lyrics: [], lyricsStyle: 'spicy', lyricsMetadata: {}, lyricsStatusMessage: 'Loading lyrics', isPlaying: true };
  else if (fx === 'instrumental') s = { lyrics: [], lyricsStyle: 'spicy', lyricsMetadata: { instrumental: true } };
  else if (fx === 'nolyrics') s = { lyrics: [], lyricsStyle: 'spicy', lyricsMetadata: {} };
  else if (fx === 'pause') s = { isPlaying: false };
  else if (fx === 'play') s = { isPlaying: true, anchorPositionMs: store.getState().playbackPosition, anchorMonotonicMs: nowMono };
  else { log('UNKNOWN_FX ' + fx); return; }
  if (['amll','spicy','credits','credits-amll','cjk','cjk-amll','loading','instrumental','nolyrics'].includes(fx)) s = { ...base, ...s };
  store.setState(s);
  if (s.isPlaying === false && s.anchorPositionMs !== undefined) log('PAUSED_AT ' + s.anchorPositionMs);
  try { require('../../store/playback-store').startPlaybackClock(); } catch (e) {}
  const st = store.getState();
  log('ACK fx=' + fx + ' style=' + st.lyricsStyle + ' lines=' + st.lyrics.length + ' rust=' + st.useRustRenderer + ' playing=' + st.isPlaying + ' pos=' + Math.round(st.playbackPosition));
}
function handle(url) {
  if (!url) return;
  if (/[?&]fx=orientation-(portrait|landscape)(?:&|$)/.test(url) && ready) {
    const orientation = require('expo-screen-orientation');
    const landscape = url.includes('orientation-landscape');
    void orientation.lockAsync(landscape ? orientation.OrientationLock.LANDSCAPE_LEFT : orientation.OrientationLock.PORTRAIT_UP).then(() => log('ACK fx=orientation-' + (landscape ? 'landscape' : 'portrait') + ' ')).catch(error => log('ORIENTATION_ERROR ' + error));
    return;
  }
  const probeMatch = /[?&]fx=probe-(seek|link)(?:&|$)/.exec(url);
  if (probeMatch && ready) { const request = /[?&]request=([a-zA-Z0-9-]+)/.exec(url); if (request) void probe(probeMatch[1], request[1]).catch(error => log('PROBE_ERROR ' + error)); return; }
  const m = /[?&]fx=([^&]+)/.exec(url); if (!m) return;
  if (!ready) { pending = m[1]; return; } apply(decodeURIComponent(m[1]));
}
RN.Linking.addEventListener('url', (e) => handle(e.url));
RN.Linking.getInitialURL().then(handle).catch(() => {});
const AR = RN.AppRegistry; const origReg = AR.registerComponent.bind(AR);
AR.registerComponent = (name, getter) => origReg(name, () => {
  const Inner = getter();
  return function SeededRoot(props) {
    const [ok, setOk] = React.useState(false);
    React.useEffect(() => { seed.then(() => {
      store = require('../../store/playback-store').usePlaybackStore;
      const bridge = require('../../lib/bridge-client').bridgeClient;
      const seekTo = bridge.seekTo.bind(bridge);
      bridge.seekTo = (position, ...args) => {
        const state = store.getState();
        log('SEEK_REQUEST actual=' + position + ' anchor=' + state.anchorPositionMs);
        if (armed && armed.kind === 'seek' && position === armed.expected && state.anchorPositionMs === armed.expected && state.playbackPosition === armed.expected && state.currentTrack.id === armed.track) {
          log('SEEK_OK request=' + armed.request + ' expected=' + armed.expected + ' actual=' + position);
          armed = null;
        }
        return seekTo(position, ...args);
      };
      store.subscribe((s, p) => { if (s.playbackPosition !== p.playbackPosition && Math.abs(s.playbackPosition - p.playbackPosition) > 900 && s.anchorMonotonicMs !== p.anchorMonotonicMs) log('STORE seek pos=' + Math.round(s.playbackPosition) + ' anchor=' + Math.round(s.anchorPositionMs)); });
      setOk(true); log('SEEDED');
      setTimeout(() => { ready = true; log('READY'); if (pending) apply(pending); }, 2500);
    }); }, []);
    return ok ? React.createElement(Inner, props) : null;
  };
});
require('expo-router/entry');
