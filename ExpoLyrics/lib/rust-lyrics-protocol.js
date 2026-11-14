// Live-track transport only. No animation tick or network work belongs here.
function buildRustTrack(trackId, generation, lines) {
  if (!trackId || !lines.length) throw new Error('Waiting for current-track timed lyrics');
  for (const line of lines) {
    if (!Number.isFinite(line.lineStartTime) || !Number.isFinite(line.lineEndTime) || line.lineEndTime <= line.lineStartTime || !line.syllables.length) throw new Error('Rust requires timed lyric lines');
    for (const atom of line.syllables) {
      if (!Number.isFinite(atom.startTime) || !Number.isFinite(atom.endTime) || atom.endTime < atom.startTime || !atom.text) throw new Error('Rust received invalid syllable timing');
    }
  }
  const serialized = JSON.stringify({ generation, track_id: trackId, lines: lines.map(line => ({
    start: line.lineStartTime, end: line.lineEndTime,
    atoms: line.syllables.map((atom, index) => {
      const next = line.syllables[index + 1];
      const gap = atom.isPartOfWord === false && next && !/\s$/u.test(atom.text) && !/^\s/u.test(next.text);
      return { text: atom.text + (gap ? ' ' : ''), start: atom.startTime, end: atom.endTime };
    }),
  })) });
  let bytes = 0;
  for (const character of serialized) {
    const code = character.codePointAt(0);
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  if (bytes > 2000000) throw new Error('Rust track payload exceeds 2 MB');
  return serialized;
}
function anchorChanged(state, previous) {
  return state.anchorPositionMs !== previous.anchorPositionMs || state.anchorMonotonicMs !== previous.anchorMonotonicMs ||
    state.isPlaying !== previous.isPlaying || state.currentTrack?.id !== previous.currentTrack?.id;
}
function projectPosition(state, now) {
  return Math.max(0, Math.min(state.currentTrack?.durationMs || 86400000,
    state.anchorPositionMs + (state.isPlaying ? Math.max(0, now - state.anchorMonotonicMs) : 0)));
}
module.exports = { buildRustTrack, anchorChanged, projectPosition };

// Preserve visual-rate time across rate changes, pause/resume and ordinary
// resyncs. A scrub preview or >250ms source discontinuity explicitly snaps.
function nextVisualAnchor(state, now, nativeMs, rate, previous, previewPositionMs) {
  const sourcePosition = projectPosition(state, now);
  const sameTrack = previous?.source.currentTrack?.id === state.currentTrack?.id;
  const correction = sameTrack ? sourcePosition - projectPosition(previous.source, now) : 0;
  const snap = previewPositionMs != null || !sameTrack || Math.abs(correction) > 250 || previous?.preview === true;
  const elapsed = previous?.playing ? Math.max(0, nativeMs - previous.nativeMs) * previous.rate : 0;
  const positionMs = previewPositionMs ?? (!snap && previous ? Math.max(0, previous.positionMs + elapsed + correction) : sourcePosition);
  return { positionMs, nativeMs, playing: previewPositionMs == null && state.isPlaying, rate, snap,
    source: { anchorPositionMs: state.anchorPositionMs, anchorMonotonicMs: state.anchorMonotonicMs,
      isPlaying: state.isPlaying, currentTrack: state.currentTrack }, preview: previewPositionMs != null };
}

// All coordinates are actual layout coordinates in the player's root. Keep the
// whole lyric surface above the dock, including scrubber and utility icons.
function rustViewport(height, lyricsTop, controlsTop) {
  const top = Math.max(0, Math.min(height, lyricsTop));
  const bottomEdge = controlsTop == null ? top : Math.max(top, Math.min(height, controlsTop));
  return { bottom: height - bottomEdge, height: bottomEdge - top };
}
module.exports.nextVisualAnchor = nextVisualAnchor;
module.exports.rustViewport = rustViewport;
