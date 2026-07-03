import type { LyricLine } from "@/types/bridge";

export type LyricsTimingMode = "karaoke" | "interpolated" | "static" | "unknown";

export function detectLyricsTimingMode(
  lyrics: LyricLine[],
  lyricsSource: string,
): LyricsTimingMode {
  if (!lyrics.length) {
    return "unknown";
  }

  const source = String(lyricsSource || "").toLowerCase();
  if (source.includes("spicy-lyrics-static")) {
    return "static";
  }
  if (source.includes("spicy-lyrics-line")) {
    return "interpolated";
  }
  if (
    source.includes("musicu-qrc") ||
    source.includes("qrc") ||
    source.includes("yrc") ||
    source.includes("kugou-krc") ||
    source.includes("spicy-lyrics-syllable")
  ) {
    return "karaoke";
  }
  if (source.includes("interpolated")) {
    return "interpolated";
  }

  let inspectedLines = 0;
  let nonUniformLines = 0;

  for (const line of lyrics) {
    const syllables = line.syllables || [];
    if (syllables.length < 3) {
      continue;
    }

    const durations = syllables
      .map((syllable) => Math.max(0, syllable.endTime - syllable.startTime))
      .filter((value) => Number.isFinite(value));
    if (durations.length < 3) {
      continue;
    }

    inspectedLines += 1;
    const mean =
      durations.reduce((sum, value) => sum + value, 0) / durations.length;
    const maxDelta = durations.reduce(
      (max, value) => Math.max(max, Math.abs(value - mean)),
      0,
    );
    if (maxDelta > 35) {
      nonUniformLines += 1;
    }
  }

  if (!inspectedLines) {
    return "unknown";
  }

  return nonUniformLines > 0 ? "karaoke" : "interpolated";
}

export function getLyricsTimingLabel(
  lyrics: LyricLine[],
  lyricsSource: string,
) {
  const mode = detectLyricsTimingMode(lyrics, lyricsSource);
  if (mode === "karaoke") {
    return "Karaoke";
  }
  if (mode === "interpolated") {
    return "Interpolated";
  }
  if (mode === "static") {
    return "Static";
  }
  return "Unknown";
}
