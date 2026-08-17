import type { LyricLine } from "@/types/bridge";

export type LyricsTimingMode = "karaoke" | "interpolated" | "static" | "unknown";

function hasMeaningfulTiming(lyrics: LyricLine[]) {
  return lyrics.some((line) => {
    const lineStart = Number(line.lineStartTime);
    const lineEnd = Number(line.lineEndTime);
    if (
      (Number.isFinite(lineStart) && lineStart > 0) ||
      (Number.isFinite(lineEnd) && lineEnd > Math.max(0, lineStart || 0))
    ) {
      return true;
    }

    return [...(line.syllables || []), ...(line.backgroundSyllables || [])].some(
      (syllable) => {
        const start = Number(syllable.startTime);
        const end = Number(syllable.endTime);
        return (
          (Number.isFinite(start) && start > 0) ||
          (Number.isFinite(end) && end > Math.max(0, start || 0))
        );
      },
    );
  });
}

export function detectLyricsTimingMode(
  lyrics: LyricLine[],
  lyricsSource: string,
): LyricsTimingMode {
  if (!lyrics.length) {
    return "unknown";
  }

  // Plain/static payloads use zero for every timestamp. Detect the data shape
  // as well as the source label so static lyrics saved to the vault (or sent by
  // a future provider) do not fall through to the synced renderer.
  if (!hasMeaningfulTiming(lyrics)) {
    return "static";
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
