import type { Track } from '@/types/bridge';

function isBridgeArtworkUri(value: string | undefined) {
  if (!value) {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  // Accept remote and inline artwork payloads shipped by the desktop bridge.
  if (/^https?:\/\//i.test(trimmed) || /^data:image\//i.test(trimmed)) {
    return true;
  }
  // Reject Windows-only filesystem paths that cannot be resolved from mobile.
  if (/^[a-z]:\\/i.test(trimmed) || /^\\\\/.test(trimmed)) {
    return false;
  }
  return false;
}

function looksLikeBase64Artwork(value: string) {
  const compact = value.replace(/\s+/g, '');
  if (!compact || compact.length < 256) {
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
    return `data:${inferDataUriMime(compact)};base64,${compact}`;
  }
  return '';
}

export async function resolveTrackArtworkUrl(track: Track | null): Promise<string> {
  if (!track) {
    return '';
  }
  return normalizeBridgeArtworkUri(track.artworkUrl);
}
