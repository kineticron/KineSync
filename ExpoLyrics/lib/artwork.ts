import type { Track } from '@/types/bridge';
import { resolveMobileArtworkUrl } from '@/lib/mobile-artwork-resolver';
import { isPrivateIpv4 } from '@/lib/network';

const MAX_INLINE_ARTWORK_BYTES = 5 * 1024 * 1024;
const MAX_INLINE_ARTWORK_CHARS = Math.ceil(MAX_INLINE_ARTWORK_BYTES * 4 / 3) + 64;

function isBridgeArtworkUri(value: string | undefined) {
  if (!value) {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  // Accept remote and inline artwork payloads shipped by the desktop bridge.
  if (/^data:image\//i.test(trimmed)) {
    if (trimmed.length > MAX_INLINE_ARTWORK_CHARS) return false;
    const match = trimmed.match(
      /^data:image\/(?:jpeg|jpg|png|webp|gif);base64,([A-Za-z0-9+/]*={0,2})$/i,
    );
    if (!match || match[1].length % 4 === 1) return false;
    return Math.floor(match[1].replace(/=+$/, '').length * 3 / 4) <= MAX_INLINE_ARTWORK_BYTES;
  }
  try {
    const url = new URL(trimmed);
    if (url.username || url.password || url.search.length > 2048 || url.hash) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || isPrivateIpv4(url.hostname));
  } catch {
    return false;
  }
}

function looksLikeBase64Artwork(value: string) {
  const compact = value.replace(/\s+/g, '');
  if (!compact || compact.length < 256 || compact.length > MAX_INLINE_ARTWORK_CHARS) {
    return false;
  }
  // Lightweight heuristic: base64 payloads are large and use this restricted charset.
  return /^[A-Za-z0-9+/=]+$/.test(compact);
}

function inferDataUriMime(base64Payload: string) {
  if (base64Payload.startsWith('/9j/')) {
    return 'image/jpeg';
  }
  if (base64Payload.startsWith('iVBORw0KGgo')) {
    return 'image/png';
  }
  if (base64Payload.startsWith('UklGR')) {
    return 'image/webp';
  }
  return 'image/jpeg';
}

export function normalizeBridgeArtworkUri(value: string | undefined) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return '';
  }
  if (isBridgeArtworkUri(trimmed)) {
    return trimmed;
  }
  if (looksLikeBase64Artwork(trimmed)) {
    const compact = trimmed.replace(/\s+/g, '');
    if (compact.length > MAX_INLINE_ARTWORK_CHARS || compact.length % 4 === 1) return '';
    return `data:${inferDataUriMime(compact)};base64,${compact}`;
  }
  return '';
}

export async function resolveTrackArtworkUrl(track: Track | null): Promise<string> {
  if (!track) {
    return '';
  }
  const suppliedArtwork = normalizeBridgeArtworkUri(track.artworkUrl);
  if (suppliedArtwork) {
    return suppliedArtwork;
  }
  return resolveMobileArtworkUrl(track);
}
