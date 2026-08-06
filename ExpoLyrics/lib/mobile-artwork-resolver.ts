import type { Track } from '@/types/bridge';

const DEEZER = 'https://api.deezer.com/search/track';
const ITUNES = 'https://itunes.apple.com/search';
const USER_AGENT = 'KineSyncDesktopBridge/1.0 (+https://github.com/KineSync/KineSync)';
const TIMEOUT_MS = 8_000;
const ITUNES_MIN_INTERVAL_MS = 3_200;
const cache = new Map<string, string>();
const MAX_ARTWORK_CACHE_ENTRIES = 96;
function cacheArtwork(key: string, url: string) {
  cache.set(key, url);
  if (cache.size > MAX_ARTWORK_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (typeof oldestKey === 'string') cache.delete(oldestKey);
  }
}
let lastItunesRequestAt = 0;

type Candidate = { title: string; artist: string; durationMs: number; url: string };

function normalize(value: string) {
  return String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function primaryArtist(value: string) {
  const raw = String(value || '').trim();
  return (raw.split(/\b(?:feat\.?|ft\.?|featuring)\b/i)[0] || raw).trim();
}

function titleScore(left: string, right: string) {
  const clean = (value: string) => normalize(value.replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, ' '));
  const a = clean(left); const b = clean(right);
  if (!a || !b) return 0;
  return a === b ? 4 : (a.includes(b) || b.includes(a) ? 2 : 0);
}

function artistOverlap(left: string, right: string) {
  const a = normalize(primaryArtist(left)); const b = normalize(primaryArtist(right));
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.72;
  const tokens = new Set(a.split(' ').filter(Boolean)); const other = b.split(' ').filter(Boolean);
  return other.length ? other.filter((token) => tokens.has(token)).length / other.length : 0;
}

function score(track: Track, candidate: Candidate) {
  const title = titleScore(track.title, candidate.title); const artist = artistOverlap(track.artist, candidate.artist);
  if (artist < 0.42 && title < 4) return -1;
  const delta = track.durationMs > 0 && candidate.durationMs > 0 ? Math.abs(track.durationMs - candidate.durationMs) : 0;
  const duration = !delta ? 0 : delta < 1_200 ? 2.5 : delta < 4_000 ? 1.5 : delta > 12_000 ? -2.5 : 0;
  return title + artist * 3 + duration;
}

function queries(track: Track) {
  const title = String(track.title || '').trim(); const artist = String(track.artist || '').trim();
  const primary = primaryArtist(artist); const album = String(track.album || '').trim();
  return [...new Set([primary && title ? `${primary} ${title}` : '', artist && title ? `${artist} ${title}` : '', primary && title && album ? `${primary} ${title} ${album}` : '', title].filter(Boolean))].slice(0, 3);
}

async function fetchJson(url: string, signal: AbortSignal) {
  const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }, signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function best(track: Track, candidates: Candidate[]) {
  let winner = ''; let scoreValue = -Infinity;
  for (const candidate of candidates) { const next = score(track, candidate); if (next > scoreValue) { winner = candidate.url; scoreValue = next; } }
  return scoreValue >= 5 ? winner : '';
}

async function deezer(track: Track, signal: AbortSignal) {
  const candidates: Candidate[] = [];
  for (const query of queries(track)) {
    const payload = await fetchJson(`${DEEZER}?limit=8&q=${encodeURIComponent(query)}`, signal);
    for (const row of Array.isArray(payload?.data) ? payload.data : []) {
      const url = String(row?.album?.cover_xl || row?.album?.cover_big || row?.album?.cover_medium || '').trim();
      if (url && row?.title) candidates.push({ title: String(row.title), artist: String(row?.artist?.name || ''), durationMs: Math.max(0, Math.floor(Number(row?.duration) || 0) * 1000), url });
    }
    const resolved = best(track, candidates); if (resolved) return resolved;
  }
  return best(track, candidates);
}

async function itunes(track: Track, signal: AbortSignal) {
  const waitMs = ITUNES_MIN_INTERVAL_MS - (Date.now() - lastItunesRequestAt);
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  lastItunesRequestAt = Date.now();
  const candidates: Candidate[] = [];
  for (const query of queries(track)) {
    const payload = await fetchJson(`${ITUNES}?term=${encodeURIComponent(query)}&entity=song&limit=8`, signal);
    for (const row of Array.isArray(payload?.results) ? payload.results : []) {
      const url = String(row?.artworkUrl600 || row?.artworkUrl100 || row?.artworkUrl60 || '').replace(/100x100bb|60x60bb/g, '600x600bb').trim();
      if (url && row?.trackName) candidates.push({ title: String(row.trackName), artist: String(row?.artistName || ''), durationMs: Math.max(0, Math.floor(Number(row?.trackTimeMillis) || 0)), url });
    }
    const resolved = best(track, candidates); if (resolved) return resolved;
  }
  return best(track, candidates);
}

export async function resolveMobileArtworkUrl(track: Track) {
  const key = String(track.id || '').trim();
  if (!key || !String(track.title || '').trim()) return '';
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key); cache.set(key, cached);
    return cached;
  }
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let url = ''; try { url = await deezer(track, controller.signal); } catch { /* iTunes fallback */ }
    if (!url) try { url = await itunes(track, controller.signal); } catch { /* no artwork */ }
    if (url) cacheArtwork(key, url);
    return url;
  } finally { clearTimeout(timer); }
}
