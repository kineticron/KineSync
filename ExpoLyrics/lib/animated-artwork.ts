import type { Track } from '@/types/bridge';

const ANIMATED_ARTWORK_API_BASE = 'https://artwork.m8tec.top';
const ITUNES_SEARCH_URL = 'https://itunes.apple.com/search';
const FETCH_TIMEOUT_MS = 12_000;
const MIN_ALBUM_MATCH_SCORE = 5;
const MIN_ITUNES_ALBUM_SCORE = 5;
const ITUNES_ALBUM_SEARCH_LIMIT = 10;

export type AnimatedArtworkUrls = {
  squareUrl: string;
};

type AnimatedArtworkSearchResponse = {
  url?: string;
  artist?: string;
  album?: string;
  title?: string;
  message?: string;
};

type ItunesAlbumCandidate = {
  collectionName: string;
  artistName: string;
  collectionViewUrl: string;
  score: number;
};

const resolvedCache = new Map<string, AnimatedArtworkUrls | null>();
const inflight = new Map<string, Promise<AnimatedArtworkUrls | null>>();

function normalizeText(input: string) {
  return String(input || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCoreTitle(input: string) {
  return normalizeText(
    String(input || '').replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, ' '),
  );
}

function normalizeAlbumName(input: string) {
  return normalizeText(input)
    .replace(/\b(the)\b/g, ' ')
    .replace(/\b(single|ep|album)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripEditionSuffix(album: string) {
  return String(album || '')
    .replace(/\s*[\(\[]\s*deluxe\s*(edition|version)?\s*[\)\]]/gi, '')
    .replace(/\s*-\s*deluxe\s*(edition|version)?/gi, '')
    .replace(/\s+deluxe\s+(edition|version)$/gi, '')
    .trim();
}

function getPrimaryArtistName(input: string) {
  const raw = String(input || '').trim();
  const parts = raw.split(/\b(?:feat\.?|ft\.?|featuring)\b/i);
  return (parts[0] || raw).trim();
}

function getArtistOverlap(trackArtist: string, candidateArtist: string) {
  const trackPrimary = normalizeText(getPrimaryArtistName(trackArtist));
  const candidatePrimary = normalizeText(getPrimaryArtistName(candidateArtist));
  if (!trackPrimary || !candidatePrimary) {
    return 0;
  }
  if (trackPrimary === candidatePrimary) {
    return 1;
  }
  if (
    trackPrimary.includes(candidatePrimary) ||
    candidatePrimary.includes(trackPrimary)
  ) {
    return 0.72;
  }
  const trackTokens = new Set(trackPrimary.split(' ').filter(Boolean));
  const candidateTokens = candidatePrimary.split(' ').filter(Boolean);
  if (!candidateTokens.length) {
    return 0;
  }
  let hits = 0;
  for (const token of candidateTokens) {
    if (trackTokens.has(token)) {
      hits += 1;
    }
  }
  return hits / candidateTokens.length;
}

const VERSION_HINTS = [
  'remix',
  'remixes',
  'live',
  'acoustic',
  'deluxe',
  'edition',
  'instrumental',
  'karaoke',
  'cover',
  'tribute',
  'vol',
  'volume',
  'iscream',
  'expanded',
  'anniversary',
];

function hasVersionHint(text: string) {
  const normalized = normalizeText(text);
  return VERSION_HINTS.some((hint) =>
    normalized.split(' ').some((token) => token === hint || token.startsWith(hint)),
  );
}

function scoreAlbumMatch(trackAlbum: string, candidateAlbum: string) {
  const trackNorm = normalizeAlbumName(trackAlbum);
  const candidateNorm = normalizeAlbumName(candidateAlbum);
  if (!trackNorm || !candidateNorm) {
    return 0;
  }
  if (trackNorm === candidateNorm) {
    return 10;
  }

  const strippedTrack = normalizeAlbumName(stripEditionSuffix(trackAlbum));
  const strippedCandidate = normalizeAlbumName(stripEditionSuffix(candidateAlbum));
  if (strippedTrack && strippedCandidate && strippedTrack === strippedCandidate) {
    return 9;
  }

  const trackTokens = trackNorm.split(' ').filter(Boolean);
  const candidateTokens = candidateNorm.split(' ').filter(Boolean);
  if (!trackTokens.length || !candidateTokens.length) {
    return 0;
  }

  const trackTokenSet = new Set(trackTokens);
  const extraTokens = candidateTokens.filter((token) => !trackTokenSet.has(token));
  const missingTokens = trackTokens.filter(
    (token) => !candidateTokens.includes(token),
  );

  if (
    extraTokens.some((token) => VERSION_HINTS.includes(token)) &&
    !hasVersionHint(trackNorm)
  ) {
    return -1;
  }

  if (missingTokens.length > 0 && extraTokens.length > 1) {
    return -1;
  }

  if (extraTokens.length > trackTokens.length + 1) {
    return -1;
  }

  let hits = 0;
  for (const token of trackTokens) {
    if (candidateTokens.includes(token)) {
      hits += 1;
    }
  }
  const overlap = hits / trackTokens.length;

  if (overlap === 1 && extraTokens.length <= 1) {
    return 7;
  }
  if (overlap >= 0.85 && extraTokens.length === 0) {
    return 8;
  }
  if (overlap >= 0.7 && extraTokens.length <= 1) {
    return 6;
  }

  return overlap * 4;
}

function scoreTitleMatch(trackTitle: string, candidateTitle: string) {
  const trackCore = normalizeCoreTitle(trackTitle);
  const candidateCore = normalizeCoreTitle(candidateTitle);
  if (!trackCore || !candidateCore) {
    return 0;
  }
  if (trackCore === candidateCore) {
    return 3;
  }
  if (trackCore.includes(candidateCore) || candidateCore.includes(trackCore)) {
    return 1.5;
  }
  return 0;
}

export function acceptsAnimatedArtworkMatch(
  track: Pick<Track, 'artist' | 'album' | 'title'>,
  response: AnimatedArtworkSearchResponse,
) {
  const returnedArtist = String(response.artist || '').trim();
  const returnedAlbum = String(response.album || '').trim();
  const returnedTitle = String(response.title || '').trim();
  const trackAlbum = String(track.album || '').trim();
  const trackTitle = String(track.title || '').trim();

  if (!returnedAlbum) {
    return false;
  }

  const artistOverlap = getArtistOverlap(track.artist, returnedArtist);
  if (artistOverlap < 0.42) {
    return false;
  }

  const albumScore = scoreAlbumMatch(trackAlbum, returnedAlbum);
  if (albumScore < MIN_ALBUM_MATCH_SCORE) {
    return false;
  }

  if (returnedTitle && trackTitle) {
    const titleScore = scoreTitleMatch(trackTitle, returnedTitle);
    if (titleScore <= 0 && albumScore < 8) {
      return false;
    }
  }

  return true;
}

function scoreItunesAlbumCandidate(
  track: Pick<Track, 'artist' | 'album' | 'title'>,
  candidate: { collectionName?: string; artistName?: string },
) {
  const artistOverlap = getArtistOverlap(track.artist, candidate.artistName || '');
  if (artistOverlap < 0.42) {
    return -1;
  }
  const albumScore = scoreAlbumMatch(track.album || '', candidate.collectionName || '');
  if (albumScore < MIN_ALBUM_MATCH_SCORE) {
    return -1;
  }
  return albumScore + artistOverlap * 3;
}

function getTrackLookupKey(track: Pick<Track, 'id' | 'artist' | 'album' | 'title'>) {
  const artist = getPrimaryArtistName(track.artist);
  const album = String(track.album || '').trim();
  const title = String(track.title || '').trim();
  if (!artist || !album) {
    return '';
  }
  return `${track.id}|${artist}|${album}|${title}`.toLowerCase();
}

function getAlbumSearchVariants(album: string, title: string) {
  const safeAlbum = String(album || '').trim();
  const safeTitle = String(title || '').trim();
  const variants: string[] = [];
  const seen = new Set<string>();

  const add = (value: string) => {
    const safe = String(value || '').trim();
    const key = safe.toLowerCase();
    if (!safe || seen.has(key)) {
      return;
    }
    seen.add(key);
    variants.push(safe);
  };

  add(safeAlbum);
  const strippedAlbum = stripEditionSuffix(safeAlbum);
  if (strippedAlbum) {
    add(strippedAlbum);
  }
  if (
    safeAlbum &&
    safeTitle &&
    !/\b(single|ep)\b/i.test(safeAlbum) &&
    normalizeCoreTitle(safeAlbum) === normalizeCoreTitle(safeTitle)
  ) {
    add(`${safeAlbum} - Single`);
    if (strippedAlbum) {
      add(`${strippedAlbum} - Single`);
    }
  }

  return variants;
}

function getItunesAlbumSearchTerms(track: Pick<Track, 'artist' | 'album' | 'title'>) {
  const artist = getPrimaryArtistName(track.artist);
  const album = String(track.album || '').trim();
  const strippedAlbum = stripEditionSuffix(album);
  const terms: string[] = [];
  const seen = new Set<string>();

  const add = (value: string) => {
    const safe = String(value || '').trim();
    const key = safe.toLowerCase();
    if (!safe || seen.has(key)) {
      return;
    }
    seen.add(key);
    terms.push(safe);
  };

  if (artist && album) {
    add(`${artist} ${album}`);
  }
  if (artist && strippedAlbum && strippedAlbum !== album) {
    add(`${artist} ${strippedAlbum}`);
  }
  if (artist && album) {
    add(`${artist} ${album} album`);
  }

  return terms;
}

function normalizeAnimatedResponse(
  track: Pick<Track, 'artist' | 'album' | 'title'>,
  payload: unknown,
): AnimatedArtworkUrls | null {
  const response = payload as AnimatedArtworkSearchResponse;
  const squareUrl = String(response?.url || '').trim();
  if (!squareUrl) {
    return null;
  }
  if (!acceptsAnimatedArtworkMatch(track, response)) {
    return null;
  }
  return { squareUrl };
}

async function fetchJson(url: string, signal: AbortSignal) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) {
    return null;
  }
  return response.json();
}

async function fetchAnimatedArtworkForParams(
  track: Pick<Track, 'artist' | 'album' | 'title'>,
  params: URLSearchParams,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(
      `${ANIMATED_ARTWORK_API_BASE}/api/v1/artwork/search?${params.toString()}`,
      {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      },
    );
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      return null;
    }
    const payload = await response.json();
    if (
      payload &&
      typeof payload === 'object' &&
      'message' in payload &&
      !('url' in payload)
    ) {
      return null;
    }
    return normalizeAnimatedResponse(track, payload);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAnimatedArtworkByAppleMusicUrl(
  track: Pick<Track, 'artist' | 'album' | 'title'>,
  appleMusicUrl: string,
) {
  const safeUrl = String(appleMusicUrl || '').trim();
  if (!safeUrl) {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const params = new URLSearchParams({ url: safeUrl });
    const response = await fetch(
      `${ANIMATED_ARTWORK_API_BASE}/api/v1/artwork/url?${params.toString()}`,
      {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      },
    );
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      return null;
    }
    const payload = await response.json();
    if (
      payload &&
      typeof payload === 'object' &&
      'message' in payload &&
      !('url' in payload)
    ) {
      return null;
    }
    return normalizeAnimatedResponse(track, payload);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function searchItunesAlbumCandidates(
  track: Pick<Track, 'artist' | 'album' | 'title'>,
): Promise<ItunesAlbumCandidate[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const ranked = new Map<string, ItunesAlbumCandidate>();

  try {
    for (const term of getItunesAlbumSearchTerms(track)) {
      const params = new URLSearchParams({
        term,
        entity: 'album',
        limit: String(ITUNES_ALBUM_SEARCH_LIMIT),
      });
      const payload = await fetchJson(
        `${ITUNES_SEARCH_URL}?${params.toString()}`,
        controller.signal,
      );
      const rows = Array.isArray(payload?.results) ? payload.results : [];
      for (const row of rows) {
        const collectionViewUrl = String(row?.collectionViewUrl || '').trim();
        const collectionName = String(row?.collectionName || '').trim();
        const artistName = String(row?.artistName || '').trim();
        if (!collectionViewUrl || !collectionName || !artistName) {
          continue;
        }
        const score = scoreItunesAlbumCandidate(track, {
          collectionName,
          artistName,
        });
        if (score < MIN_ITUNES_ALBUM_SCORE) {
          continue;
        }
        const existing = ranked.get(collectionViewUrl);
        if (!existing || score > existing.score) {
          ranked.set(collectionViewUrl, {
            collectionName,
            artistName,
            collectionViewUrl,
            score,
          });
        }
      }
    }
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }

  return [...ranked.values()].sort((a, b) => b.score - a.score);
}

async function resolveViaItunesAlbumUrl(
  track: Pick<Track, 'artist' | 'album' | 'title'>,
) {
  const candidates = await searchItunesAlbumCandidates(track);
  for (const candidate of candidates) {
    const resolved = await fetchAnimatedArtworkByAppleMusicUrl(
      track,
      candidate.collectionViewUrl,
    );
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

export async function resolveAnimatedArtworkForTrack(
  track: Track | null,
): Promise<AnimatedArtworkUrls | null> {
  if (!track) {
    return null;
  }
  const lookupKey = getTrackLookupKey(track);
  if (!lookupKey) {
    return null;
  }
  if (resolvedCache.has(lookupKey)) {
    return resolvedCache.get(lookupKey) ?? null;
  }
  const pending = inflight.get(lookupKey);
  if (pending) {
    return pending;
  }

  const artist = getPrimaryArtistName(track.artist);
  const title = String(track.title || '').trim();
  const albumVariants = getAlbumSearchVariants(track.album || '', title);

  const request = (async () => {
    for (const album of albumVariants) {
      const params = new URLSearchParams({ artist, album });
      if (title) {
        params.set('title', title);
      }
      const resolved = await fetchAnimatedArtworkForParams(track, params);
      if (resolved) {
        resolvedCache.set(lookupKey, resolved);
        return resolved;
      }

      if (title) {
        const albumOnlyParams = new URLSearchParams({ artist, album });
        const albumOnlyResolved = await fetchAnimatedArtworkForParams(
          track,
          albumOnlyParams,
        );
        if (albumOnlyResolved) {
          resolvedCache.set(lookupKey, albumOnlyResolved);
          return albumOnlyResolved;
        }
      }
    }

    const viaItunes = await resolveViaItunesAlbumUrl(track);
    resolvedCache.set(lookupKey, viaItunes);
    return viaItunes;
  })();

  inflight.set(lookupKey, request);
  try {
    return await request;
  } finally {
    inflight.delete(lookupKey);
  }
}
