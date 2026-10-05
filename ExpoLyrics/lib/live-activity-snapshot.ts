import { getPrimaryLineText } from '@/lib/active-lyric-line';
import { formatLyricsSourceLabel } from '@/lib/format-lyrics-source';
import { detectLyricsTimingMode } from '@/lib/lyrics-timing';
import { extractSourceFromStatusMessage, trimTrailingSourceFromAction } from '@/lib/lyrics-status';
import type { ConnectionStatus, LyricLine, LyricsMetadata, Track } from '@/types/bridge';

export type LiveActivityInput = {
  currentTrack: Track | null;
  lyrics: LyricLine[];
  lyricsMetadata: LyricsMetadata;
  lyricsSource: string;
  lyricsStatusMessage: string;
  playbackMode: 'mobile' | 'desktop';
  connectionStatus: ConnectionStatus;
  anchorPositionMs: number;
  anchorMonotonicMs: number;
  isPlaying: boolean;
};

// This bounds the host-side transfer; the native publisher independently enforces
// a 2,800-byte limit on the current ActivityKit state using Swift's JSON encoder.
const cleanText = (text: string, length = 240) => Array.from(String(text || '').replace(/\s+/g, ' ').trim()).slice(0, length).join('');
const finite = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0;

export function makeLiveActivitySnapshot(input: LiveActivityInput, monotonicMs: number, wallMs: number, includeLines = true) {
  const track = input.currentTrack;
  const source = extractSourceFromStatusMessage(input.lyricsStatusMessage) || input.lyricsSource ||
    (input.playbackMode === 'mobile' ? 'On-device playback' : input.connectionStatus === 'connected' ? 'Waiting for source' : 'Bridge offline');
  const durationMs = finite(track?.durationMs ?? 0);
  const projected = finite(input.anchorPositionMs) + (input.isPlaying ? finite(monotonicMs - input.anchorMonotonicMs) : 0);
  return {
    // Stop when the desktop feed disconnects; its old playing flag is no longer
    // authoritative. Mobile playback is independent of the bridge connection.
    trackId: input.playbackMode === 'desktop' && input.connectionStatus !== 'connected' ? '' : track?.id || '',
    title: cleanText(track?.title || 'Unknown song'),
    artist: cleanText(track?.artist || 'Unknown artist'),
    album: cleanText(track?.album || '', 120),
    source: cleanText(formatLyricsSourceLabel(source), 120),
    status: cleanText(trimTrailingSourceFromAction(input.lyricsStatusMessage, source).replace(/\s+from\s*$/i, '')),
    timingMode: detectLyricsTimingMode(input.lyrics, input.lyricsSource),
    instrumental: Boolean(input.lyricsMetadata.instrumental),
    isPlaying: Boolean(track && input.isPlaying),
    positionMs: durationMs > 0 ? Math.min(durationMs, projected) : projected,
    durationMs,
    sampledAtMs: wallMs,
    lines: includeLines ? input.lyrics.slice(0, 5000).filter((line) =>
      Number.isFinite(line.lineStartTime) && Number.isFinite(line.lineEndTime) &&
      line.lineStartTime >= 0 && line.lineEndTime > line.lineStartTime,
    ).map((line) => ({
      startMs: line.lineStartTime,
      endMs: line.lineEndTime,
      text: cleanText(getPrimaryLineText(line)),
    })).filter((line) => line.text.length > 0) : undefined,
  };
}

export function liveActivityInputChanged(next: LiveActivityInput, previous: LiveActivityInput) {
  return next.currentTrack !== previous.currentTrack || next.lyrics !== previous.lyrics ||
    next.lyricsMetadata !== previous.lyricsMetadata || next.lyricsSource !== previous.lyricsSource ||
    next.lyricsStatusMessage !== previous.lyricsStatusMessage || next.isPlaying !== previous.isPlaying ||
    next.anchorPositionMs !== previous.anchorPositionMs || next.anchorMonotonicMs !== previous.anchorMonotonicMs ||
    next.connectionStatus !== previous.connectionStatus || next.playbackMode !== previous.playbackMode;
}
