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
  const normalize = text => String(text || "").normalize("NFKC").replace(/\s/gu, "")
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

module.exports = { pickAutoLyrics, timingRank }
