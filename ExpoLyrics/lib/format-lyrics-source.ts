export function formatLyricsSourceLabel(source: string) {
  const normalized = String(source || "").trim();
  if (!normalized) {
    return "No source";
  }

  const lower = normalized.toLowerCase();
  if (lower.includes("local-vault-karaoke")) {
    return "Local · Karaoke";
  }
  if (lower.includes("local-vault-line")) {
    return "Local · Line";
  }
  if (lower.includes("local-vault")) {
    return "Local vault";
  }
  if (lower.includes("spicy-lyrics-line")) {
    return "Spicy · Line";
  }
  if (lower.includes("spicy-lyrics-syllable")) {
    return "Spicy · Karaoke";
  }
  if (lower.includes("spicy-lyrics-static")) {
    return "Spicy · Static";
  }
  if (lower.includes("spicy")) {
    return "Spicy";
  }
  if (lower.includes("musixmatch")) {
    return "Musixmatch";
  }
  if (lower.includes("kugou")) {
    return "Kugou";
  }
  if (lower.includes("netease")) {
    return "Netease";
  }
  if (lower.includes("lrclib")) {
    return "LrcLib";
  }
  if (lower.includes("qq")) {
    return "QQ Music";
  }
  if (lower.includes("musicu-qrc") || lower.includes("qrc")) {
    return "QRC";
  }

  return normalized;
}
