// Live-track transport only. No animation tick or network work belongs here.
function getBackgroundEnd(line) {
  let end = line.lineEndTime;
  for (const syllable of line.backgroundSyllables ?? []) end = Math.max(end, syllable.endTime);
  for (const background of line.spicyBackgrounds ?? []) {
    end = Math.max(end, background.lineEndTime);
    for (const syllable of background.syllables ?? []) end = Math.max(end, syllable.endTime);
  }
  return end;
}
function invalidVoiceTiming(voice) {
  if (!voice || !Array.isArray(voice.words) || !voice.words.length) return true;
  for (const word of voice.words) {
    if (!Number.isFinite(word.start) || !Number.isFinite(word.end) || word.end < word.start || !word.text) return true;
  }
  return false;
}
function buildRustTrack(trackId, generation, lines, prepared) {
  if (!trackId || !lines.length) throw new Error('Waiting for current-track timed lyrics');
  for (const line of lines) {
    if (!Number.isFinite(line.lineStartTime) || !Number.isFinite(line.lineEndTime) || line.lineEndTime <= line.lineStartTime || !line.syllables.length) throw new Error('Rust requires timed lyric lines');
    for (const atom of line.syllables) {
      if (!Number.isFinite(atom.startTime) || !Number.isFinite(atom.endTime) || atom.endTime < atom.startTime || !atom.text) throw new Error('Rust received invalid syllable timing');
    }
  }
  const serialized = JSON.stringify({ schema: 6, ...(prepared ? { settings: prepared.settings } : {}), ...(prepared?.credits ? { credits: prepared.credits } : {}), generation, track_id: trackId, lines: lines.map((line, lineIndex) => {
    const backgroundEnd = getBackgroundEnd(line);
    const backgrounds = prepared?.backgrounds?.[lineIndex] ?? [];
    if (backgrounds.some(invalidVoiceTiming)) throw new Error('Rust received invalid background vocal timing');
    return {
      start: line.lineStartTime, end: line.lineEndTime,
      ...(backgroundEnd > line.lineEndTime ? { background_end: backgroundEnd } : {}),
      ...(prepared ? { paint: prepared.paints[lineIndex] } : {}),
      ...(backgrounds.length ? { backgrounds } : {}),
      atoms: line.syllables.map((atom, index) => {
        const next = line.syllables[index + 1];
        const gap = atom.isPartOfWord === false && next && !/\s$/u.test(atom.text) && !/^\s/u.test(next.text);
        return { text: atom.text + (!prepared && gap ? ' ' : ''), start: atom.startTime, end: atom.endTime };
      }),
    };
  }) });
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

module.exports.nextVisualAnchor = nextVisualAnchor;
