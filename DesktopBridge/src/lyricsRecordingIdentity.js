"use strict";

// Conservative catalog aliases. Fold the script variants used by these catalogs,
// without allowing substring song/artist matches or discarding version labels.
function foldCatalogText(value) {
  const variants = { 來: "来", 財: "财", 攬: "揽" };
  return String(value || "").normalize("NFKC").replace(/[來財攬]/gu, char => variants[char]).toLowerCase().trim();
}
function translatedTitleBase(value) {
  const title = String(value || "").normalize("NFKC").trim();
  const match = title.match(/^(.+?)\s*\(([a-z][a-z\s'’-]+)\)$/i);
  if (!match || !/\p{Script=Han}/u.test(match[1]) ||
      /\b(?:feat|ft|featuring|with|live|remix|mix|acoustic|instrumental|karaoke|slowed|sped|version|remaster|cover)\b/i.test(match[2])) return title;
  // A bare artist name in brackets remains significant. Require a phrase with
  // translation markers rather than treating every Latin bracket as a feature.
  return /\b(?:from|of|the|to|in|on|and|pinyin|romanized|romaji)\b/i.test(match[2]) && match[2].trim().split(/\s+/).length >= 2 ? match[1].trim() : title;
}
function titleKey(value) {
  return foldCatalogText(translatedTitleBase(value)).replace(/[\s\p{P}]/gu, "");
}
function artistAliases(value) {
  const folded = foldCatalogText(value).replace(/\s+/g, " ");
  const aliases = new Set([folded]);
  const bilingual = folded.match(/^([\p{Script=Han}]+)\s*([a-z][a-z\s]+)$/u);
  if (bilingual) { aliases.add(bilingual[1]); aliases.add(bilingual[2].trim()); }
  return aliases;
}
function recordingIdentityMatches(track, title, artist, durationMs, toleranceMs = 3000) {
  if (!titleKey(track?.title) || titleKey(track.title) !== titleKey(title)) return false;
  const wanted = artistAliases(track.artist), actual = artistAliases(artist);
  if (![...wanted].some(alias => alias && actual.has(alias))) return false;
  const duration = Number(durationMs), expected = Number(track.durationMs);
  return expected > 0 ? Number.isFinite(duration) && duration > 0 && Math.abs(expected - duration) <= toleranceMs : duration > 0;
}
module.exports = { foldCatalogText, translatedTitleBase, titleKey, artistAliases, recordingIdentityMatches };
