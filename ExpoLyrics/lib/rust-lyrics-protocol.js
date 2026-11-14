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
