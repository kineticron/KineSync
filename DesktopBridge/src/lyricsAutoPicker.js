"use strict"

// Inputs are parsed provider packets. Never invent word precision for line lyrics.
function timingRank(packet) {
  if (!packet?.lyrics?.length) return 0
  const source = String(packet.source || "").toLowerCase()
  if (/static|none/.test(source)) return 0
  if (/karaoke|syllable|word/.test(source)) return 2
  if (/line/.test(source)) return 1
  return 0
}

function pickAutoLyrics(lrcRed, spicy) {
  const lrcRank = timingRank(lrcRed)
  const spicyRank = timingRank(spicy)
  const choose = (result, reason) => ({ result: result || null, reason })
  if (!lrcRank && !spicyRank) return choose(spicy?.lyrics?.length ? spicy : null, "no-synced-lyrics")
  const attribution = spicy?.metadata?.attribution
  if (spicyRank && (attribution?.community || ["spicy_lyrics", "spl"].includes(String(attribution?.source || "").trim().toLowerCase()))) {
    return choose(spicy, "spicy-community")
  }
  if (!spicyRank) return choose(lrcRed, "lrc-only-synced")
  if (!lrcRank) return choose(spicy, "spicy-only-synced")
  const a = lrcRed.lyrics
  const b = spicy.lyrics
  if (a.length !== b.length) return choose(spicy, "line-count-mismatch")
  const normalize = text => String(text || "").normalize("NFKC").toLowerCase().replace(/[\s\p{P}]/gu, "")
  const fullText = (lines, background) => normalize(lines.map(line => {
    const parts = background ? line.backgroundSyllables : line.syllables
    return Array.isArray(parts) && parts.length
      ? parts.map(part => part.text || "").join("")
      : background ? line.backgroundText || "" : line.text || ""
  }).join(""))
  if (fullText(a, false) !== fullText(b, false)) return choose(spicy, "lead-text-mismatch")
  if (fullText(a, true) !== fullText(b, true)) return choose(spicy, "background-text-mismatch")
  for (let i = 0; i < a.length; i++) {
    for (const key of ["lineStartTime", "lineEndTime"]) {
      if (!Number.isFinite(a[i][key]) || !Number.isFinite(b[i][key]) ||
          Math.abs(a[i][key] - b[i][key]) > 100) return choose(spicy, "line-timing-mismatch")
    }
  }
  if (lrcRank < spicyRank) return choose(spicy, "spicy-finer-timing")
  return choose(lrcRed, "equivalent-lrc")
}

// The community exception applies to syllable packets, independently of line priority.
const isCommunitySpicy = packet => {
  if (!String(packet?.source || "").toLowerCase().includes("spicy-lyrics-syllable")) return false
  const attribution = packet?.metadata?.attribution
  return Boolean(attribution?.community || ["spicy_lyrics", "spl"].includes(String(attribution?.source || "").trim().toLowerCase()))
}

// Mirrors getSourcePriorityBucket exactly; its existing service implementation is unchanged.
function sourcePriority(packetOrSource) {
  const source = String(typeof packetOrSource === "string" ? packetOrSource : packetOrSource?.source || "").toLowerCase()
  if (source.includes("lrc-red-karaoke")) return 700
  if (source.includes("lrc-red-line")) return 370
  if (source.includes("local-vault-karaoke")) return 720
  if (source.includes("local-vault-line")) return 380
  if (source.includes("spicy-lyrics-syllable")) return 680
  if (source.includes("kugou-krc")) return 620
  if (source.includes("qq-musicu-qrc")) return 600
  if (source.includes("netease-yrc")) return 560
  if (source.includes("musixmatch-richsync")) return 520
  if (source.includes("spicy-lyrics-line")) return 360
  if (source.includes("spicy-lyrics-static")) return 180
  if (source.includes("lrclib")) return 320
  if (source.includes("netease-lrc")) return 300
  if (source.includes("musixmatch") && !source.includes("richsync")) return 280
  if (source.includes("qq-")) return 240
  return 200
}

function emitPickerTrace(stage, payload) {
  const isDev = typeof __DEV__ !== "undefined"
    ? Boolean(__DEV__)
    : (typeof process !== "undefined" && (process?.env?.NODE_ENV === "development" || process?.env?.NODE_ENV === "test"));
  if (!isDev) return;
  try {
    console.log("[PickerTrace]", JSON.stringify({
      stage,
      ...payload,
    }));
  } catch {}
}

function evaluatePreferAutoCandidate(track, current, candidate) {
  if (!candidate?.lyrics?.length) return { upgrade: false, rule: "no-candidate-lyrics" };
  if (!current?.lyrics?.length) return { upgrade: true, rule: "initial-candidate" };
  const currentSource = String(current.source || "").toLowerCase();
  const candidateSource = String(candidate.source || "").toLowerCase();
  const currentVault = currentSource.includes("local-vault");
  const candidateVault = candidateSource.includes("local-vault");
  if (currentVault || candidateVault) {
    const upgrade = sourcePriority(candidate) > sourcePriority(current);
    return { upgrade, rule: "local-vault-priority" };
  }
  const currentCommunity = isCommunitySpicy(current);
  const candidateCommunity = isCommunitySpicy(candidate);
  if (currentCommunity || candidateCommunity) {
    const upgrade = candidateCommunity && !currentCommunity;
    return { upgrade, rule: "community-spicy-priority" };
  }

  const currentLrcKaraoke = currentSource.includes("lrc-red-karaoke");
  const candidateLrcKaraoke = candidateSource.includes("lrc-red-karaoke");
  const currentSpicy = currentSource.includes("spicy-lyrics-syllable");
  const candidateSpicy = candidateSource.includes("spicy-lyrics-syllable");
  if ((currentLrcKaraoke && candidateSpicy) || (candidateLrcKaraoke && currentSpicy)) {
    const lrc = currentLrcKaraoke ? current : candidate;
    const spicy = currentSpicy ? current : candidate;
    const attribution = spicy?.metadata?.attribution || {};
    const provider = `${attribution.source || ""} ${attribution.provider || ""}`.toLowerCase();
    if (!provider.includes("apple")) {
      const upgrade = candidate === lrc;
      return { upgrade, rule: "lrc-over-non-apple-spicy" };
    }
    const pick = pickAutoLyrics(lrc, spicy);
    const upgrade = pick.result === candidate;
    return { upgrade, rule: pick.reason };
  }
  const karaoke = source => !source.includes("netease-lrc") &&
    /spicy-lyrics-syllable|kugou-krc|qq-musicu-qrc|richsync|karaoke|yrc/.test(source);
  const currentKaraoke = karaoke(currentSource);
  const candidateKaraoke = karaoke(candidateSource);
  const currentSpicyLine = currentSource.includes("spicy-lyrics-line");
  const candidateSpicyLine = candidateSource.includes("spicy-lyrics-line");
  if (currentSpicyLine !== candidateSpicyLine) {
    if (currentKaraoke || candidateKaraoke) {
      return { upgrade: Boolean(candidateKaraoke), rule: "karaoke-over-spicy-line" };
    }
    // Preserve the existing lrc.red-line exception before Spicy's line rule.
    if (currentSource.includes("lrc-red-line") || candidateSource.includes("lrc-red-line")) {
      return { upgrade: candidateSource.includes("lrc-red-line"), rule: "lrc-red-line-priority" };
    }
    return { upgrade: candidateSpicyLine, rule: "spicy-line-priority" };
  }
  const upgrade = sourcePriority(candidate) > sourcePriority(current);
  return { upgrade, rule: "source-priority" };
}

function shouldPreferAutoCandidate(track, current, candidate) {
  return evaluatePreferAutoCandidate(track, current, candidate).upgrade;
}

function autoCandidateCouldOutrank(track, current, source) {
  if (!current?.lyrics?.length) return true
  const normalized = String(source || "").toLowerCase()
  if (isCommunitySpicy(current)) return normalized === "local-vault"
  // Pending Spicy can be community syllable, or non-equivalent Apple Music.
  if (normalized === "spicy-lyrics") return true
  const bounds = { "local-vault": 720, "lrc-red": 700, kugou: 620, "qq-direct": 600, netease: 560, musixmatch: 520, lrclib: 320 }
  return (bounds[normalized] ?? 200) >= sourcePriority(current)
}

module.exports = { pickAutoLyrics, timingRank, shouldPreferAutoCandidate, evaluatePreferAutoCandidate, autoCandidateCouldOutrank, sourcePriority, isCommunitySpicy, emitPickerTrace }
