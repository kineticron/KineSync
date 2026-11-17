function lines(kind) {
  const { DEMO_LYRICS } = require('./lib/onboarding-demo-lyrics');
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
  try { require('./store/playback-store').startPlaybackClock(); } catch (e) {}
  const st = store.getState();
  log('ACK fx=' + fx + ' style=' + st.lyricsStyle + ' lines=' + st.lyrics.length + ' rust=' + st.useRustRenderer + ' playing=' + st.isPlaying + ' pos=' + Math.round(st.playbackPosition));
}
