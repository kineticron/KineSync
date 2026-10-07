import { formatLyricsSourceLabel } from '@/lib/format-lyrics-source';
import { detectLyricsTimingMode } from '@/lib/lyrics-timing';
import { extractSourceFromStatusMessage, trimTrailingSourceFromAction } from '@/lib/lyrics-status';
import type { ConnectionStatus, LyricLine, Track } from '@/types/bridge';

export type LiveActivityInput = {
  currentTrack: Track | null;
  lyrics: LyricLine[];
  lyricsSource: string;
  lyricsStatusMessage: string;
  playbackMode: 'mobile' | 'desktop';
  connectionStatus: ConnectionStatus;
  isPlaying: boolean;
};

// This bounds the host-side transfer; the native publisher independently enforces
// a 2,800-byte limit on the current ActivityKit state using Swift's JSON encoder.
const cleanText = (text: string, length = 240) => Array.from(String(text || '').replace(/\s+/g, ' ').trim()).slice(0, length).join('');

export function makeLiveActivitySnapshot(input: LiveActivityInput) {
  // A disconnected bridge must not display its stale track.
  const track = input.playbackMode === 'desktop' && input.connectionStatus !== 'connected' ? null : input.currentTrack;
  const source = (track ? extractSourceFromStatusMessage(input.lyricsStatusMessage) || input.lyricsSource : '') ||
    (input.playbackMode === 'mobile' ? 'On-device playback' : input.connectionStatus === 'connected' ? 'Waiting for source' : 'Bridge offline');
  return {
    // Empty track IDs select the native static waiting presentation.
    trackId: track?.id || '',
    title: cleanText(track?.title || 'KineSync'),
    artist: cleanText(track ? track.artist || 'Unknown artist' : ''),
    album: cleanText(track?.album || '', 120),
    artworkUrl: track?.artworkUrl || '',
    source: cleanText(formatLyricsSourceLabel(source), 120),
    status: track ? cleanText(trimTrailingSourceFromAction(input.lyricsStatusMessage, source).replace(/\s+from\s*$/i, '')) : 'Waiting for a song',
    timingMode: track ? detectLyricsTimingMode(input.lyrics, input.lyricsSource) : 'unknown',
    isPlaying: Boolean(track && input.isPlaying),
  };
}

export function liveActivityInputChanged(next: LiveActivityInput, previous: LiveActivityInput) {
  return next.currentTrack !== previous.currentTrack || next.lyrics !== previous.lyrics ||
    next.lyricsSource !== previous.lyricsSource ||
    next.lyricsStatusMessage !== previous.lyricsStatusMessage || next.isPlaying !== previous.isPlaying ||
    next.connectionStatus !== previous.connectionStatus || next.playbackMode !== previous.playbackMode;
}
