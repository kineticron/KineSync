import { normalizeBridgeArtworkUri } from '@/lib/artwork';
import type {
  LyricsPacket,
  PlaybackPacket,
  ShareGifResultPacket,
  VaultSaveResultPacket,
} from '@/types/bridge';

export const MAX_BRIDGE_PACKET_BYTES = 8 * 1024 * 1024;
export const MAX_LYRICS_LINES = 5_000;
export const MAX_SYLLABLES_PER_LINE = 500;
export const MAX_GIF_BYTES = 5 * 1024 * 1024;

function boundedString(value: unknown, max: number) {
  return typeof value === 'string' && value.length <= max ? value : null;
}

function finiteNumber(value: unknown, min = -Infinity, max = Infinity) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

function validLyricLine(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const line = value as Record<string, unknown>;
  const start = finiteNumber(line.lineStartTime, 0, 24 * 60 * 60 * 1000);
  const end = finiteNumber(line.lineEndTime, 0, 24 * 60 * 60 * 1000);
  if (start === null || end === null || end < start || !Array.isArray(line.syllables) || line.syllables.length > MAX_SYLLABLES_PER_LINE) return false;
  for (const syllable of line.syllables) {
    if (!syllable || typeof syllable !== 'object') return false;
    const s = syllable as Record<string, unknown>;
    if (boundedString(s.text, 2_000) === null || finiteNumber(s.startTime, 0, 24 * 60 * 60 * 1000) === null || finiteNumber(s.endTime, 0, 24 * 60 * 60 * 1000) === null) return false;
  }
  if (line.translatedText !== undefined && boundedString(line.translatedText, 20_000) === null) return false;
  return true;
}

function validatePlayback(packet: Record<string, unknown>): PlaybackPacket | null {
  if (boundedString(packet.trackId, 512) === null || boundedString(packet.title, 2_000) === null || boundedString(packet.artist, 2_000) === null) return null;
  const duration = finiteNumber(packet.durationMs, 0, 24 * 60 * 60 * 1000);
  const position = finiteNumber(packet.positionMs, 0, 24 * 60 * 60 * 1000);
  const timestamp = finiteNumber(packet.timestamp, 0);
  if (duration === null || position === null || timestamp === null || typeof packet.isPlaying !== 'boolean') return null;
  const artworkCandidate =
    packet.artworkUrl === undefined || typeof packet.artworkUrl !== 'string' || packet.artworkUrl.length > 7 * 1024 * 1024
      ? undefined
      : packet.artworkUrl;
  const artworkUrl = packet.artworkUrl === undefined ? undefined : normalizeBridgeArtworkUri(artworkCandidate);
  if (packet.artworkUrl !== undefined && !artworkUrl) return null;
  return { ...packet, durationMs: duration, positionMs: Math.min(position, duration || position), timestamp, artworkUrl } as PlaybackPacket;
}

function validateLyrics(packet: Record<string, unknown>): LyricsPacket | null {
  if (boundedString(packet.trackId, 512) === null || boundedString(packet.source, 256) === null || !Array.isArray(packet.lyrics) || packet.lyrics.length > MAX_LYRICS_LINES || !packet.lyrics.every(validLyricLine)) return null;
  return packet as unknown as LyricsPacket;
}

function validBase64(value: unknown) {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_GIF_BYTES * 4 / 3) + 16 || value.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  return Math.floor(value.replace(/=+$/, '').length * 3 / 4) <= MAX_GIF_BYTES;
}

export function validateInboundBridgePacket(data: unknown):
  | { type: 'hello:ack'; ok?: boolean }
  | PlaybackPacket
  | LyricsPacket
  | ShareGifResultPacket
  | VaultSaveResultPacket
  | null {
  const raw = typeof data === 'string' ? data : '';
  if (!raw || raw.length > MAX_BRIDGE_PACKET_BYTES) return null;
  let packet: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    packet = parsed as Record<string, unknown>;
  } catch { return null; }
  if (packet.type === 'hello:ack') return typeof packet.ok === 'boolean' ? packet as { type: 'hello:ack'; ok: boolean } : null;
  if (packet.type === 'playback') return validatePlayback(packet);
  if (packet.type === 'lyrics') return validateLyrics(packet);
  if (packet.type === 'vault:save:result') {
    if (typeof packet.ok !== 'boolean' || (packet.error !== undefined && boundedString(packet.error, 2_000) === null)) return null;
    return packet as unknown as VaultSaveResultPacket;
  }
  if (packet.type === 'share:gif:result') {
    if (boundedString(packet.requestId, 256) === null || typeof packet.ok !== 'boolean') return null;
    if (packet.mimeType !== undefined && packet.mimeType !== 'image/gif') return null;
    if (packet.fileName !== undefined && boundedString(packet.fileName, 128) === null) return null;
    if (packet.base64 !== undefined && !validBase64(packet.base64)) return null;
    return packet as unknown as ShareGifResultPacket;
  }
  return null;
}
