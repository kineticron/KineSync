"use strict";

const SPICY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// Provenance survives local-vault labels, imports, and in-app device transfers.
function isSpicyLyricsResponse({ metadata = {}, originalSource = "", source = "", sourceLabel = "" } = {}) {
  const origin = String(originalSource || metadata?.vault?.originalSource || source || sourceLabel).toLowerCase();
  if (origin.includes("lrc-red")) return false;
  return Boolean(metadata?.spicyApi) || origin.includes("spicy-lyrics") || ["spicy_lyrics", "spl"].includes(metadata?.attribution?.source);
}

function isSpicyCommunityLyrics(entry = {}) {
  const metadata = entry.metadata;
  const attribution = metadata?.attribution;
  const community = attribution?.provider === "Spicy Lyrics" || ["spicy_lyrics", "spl"].includes(attribution?.source);
  // Unattributed legacy Spicy cache entries are restricted conservatively.
  return isSpicyLyricsResponse(entry) && (community || !attribution?.provider);
}

function spicyLyricsExpiresAt(entry = {}) {
  // Also expire old official-API caches whose provider was Apple/Spotify/unknown.
  if (!isSpicyLyricsResponse(entry)) return null;
  const fetchedAt = Number(entry.metadata?.spicyApi?.fetchedAt ?? entry.metadata?.vault?.savedAt ?? entry.savedAt ?? 0);
  const declared = Number(entry.metadata?.spicyApi?.expiresAt || 0);
  if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) return 0;
  return Math.min(fetchedAt + SPICY_MAX_AGE_MS, Number.isFinite(declared) && declared > 0 ? declared : fetchedAt + SPICY_MAX_AGE_MS);
}

function withSpicyFreshness(entry) {
  const expiresAt = spicyLyricsExpiresAt(entry);
  if (expiresAt === null) return entry.metadata;
  return { ...entry.metadata, spicyApi: {
    fetchedAt: Number(entry.metadata?.spicyApi?.fetchedAt ?? entry.metadata?.vault?.savedAt ?? entry.savedAt ?? 0), expiresAt,
  } };
}

function assertLyricsExportAllowed(entry) {
  if (isSpicyCommunityLyrics(entry)) throw new Error("Spicy Lyrics community syncs cannot be exported. They can only be cached inside KineSync.");
}

module.exports = { SPICY_MAX_AGE_MS, isSpicyLyricsResponse, isSpicyCommunityLyrics, spicyLyricsExpiresAt, withSpicyFreshness, assertLyricsExportAllowed };
