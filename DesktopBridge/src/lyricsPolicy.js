"use strict";

const SPICY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function spicyOriginEvidence(metadata = {}) {
  const origin = metadata?.fetchOrigin;
  if (origin && typeof origin === "object") {
    const evidence = `${origin.host || ""} ${origin.url || ""} ${origin.source || ""} ${origin.provider || ""}`.toLowerCase();
    if (evidence.includes("spicylyrics") || evidence.includes("spicy-lyrics") || evidence.includes("spicy_lyrics")) return true;
  }
  if (metadata?.spicyApi) return true;
  return ["spicy_lyrics", "spl"].includes(metadata?.attribution?.source);
}

// Provenance survives local-vault labels, imports, relabels, and device transfers.
// Explicit Spicy origin metadata outranks a misleading displayed lrc.red label.
function isSpicyLyricsResponse({ metadata = {}, originalSource = "", source = "", sourceLabel = "" } = {}) {
  if (spicyOriginEvidence(metadata)) return true;
  const labels = [originalSource, metadata?.vault?.originalSource, source, sourceLabel]
    .map(value => String(value || "").toLowerCase());
  // Check every label independently. A Spicy label cannot be masked by a
  // different lrc.red or local-vault label elsewhere on the entry.
  if (labels.some(label => label.includes("spicy-lyrics"))) return true;
  if (labels.some(label => label.includes("lrc-red"))) return false;
  return false;
}

function isSpicyCommunityLyrics(entry = {}) {
  // Community status, displayed provider, formatting, and source labels are
  // irrelevant. Every response fetched through api.spicylyrics.org is blocked.
  return isSpicyLyricsResponse(entry);
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
    ...(entry.metadata?.spicyApi || {}),
    fetchedAt: Number(entry.metadata?.spicyApi?.fetchedAt ?? entry.metadata?.vault?.savedAt ?? entry.savedAt ?? 0), expiresAt,
  } };
}

function assertLyricsExportAllowed(entry) {
  if (isSpicyLyricsResponse(entry)) throw new Error("Spicy lyrics cannot be exported. Export from lrc.red instead.");
}

module.exports = { SPICY_MAX_AGE_MS, isSpicyLyricsResponse, isSpicyCommunityLyrics, spicyLyricsExpiresAt, withSpicyFreshness, assertLyricsExportAllowed };
