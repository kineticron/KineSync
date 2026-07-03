import type { LyricLine, LyricSyllable } from "@/types/bridge";

export type ActiveLyricLineSnapshot = {
  text: string;
  lineStartMs: number;
  lineEndMs: number;
  syllablePayload: string;
};

function findActiveLineIndex(positionMs: number, lyrics: LyricLine[]) {
  let low = 0;
  let high = lyrics.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const line = lyrics[mid];
    if (positionMs < line.lineStartTime) {
      high = mid - 1;
    } else if (positionMs >= line.lineEndTime) {
      low = mid + 1;
    } else {
      return mid;
    }
  }
  return -1;
}

function findLastEndedLineIndex(positionMs: number, lyrics: LyricLine[]) {
  let low = 0;
  let high = lyrics.length - 1;
  let result = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lyrics[mid].lineEndTime <= positionMs) {
      result = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return result;
}

function findFirstUpcomingLineIndex(positionMs: number, lyrics: LyricLine[]) {
  let low = 0;
  let high = lyrics.length - 1;
  let result = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lyrics[mid].lineStartTime > positionMs) {
      result = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return result;
}

function isCensorshipBoundary(leftText: string, rightText: string) {
  const left = String(leftText || "").trim();
  const right = String(rightText || "").trim();
  if (!left || !right) {
    return false;
  }
  const censorRun = /^[*＊•·]+$/;
  return (
    (censorRun.test(left) && /^[A-Za-z0-9]/.test(right)) ||
    (/[A-Za-z0-9]$/.test(left) && censorRun.test(right))
  );
}

export function getPrimaryLineText(line: LyricLine) {
  const syllables = line.syllables || [];
  if (!syllables.length) {
    return "";
  }

  let text = String(syllables[0]?.text || "");
  for (let index = 1; index < syllables.length; index += 1) {
    const prev = syllables[index - 1];
    const current = syllables[index];
    const currentText = String(current?.text || "");
    if (!currentText) {
      continue;
    }
    const hasWhitespaceBoundary = /\s$/.test(text) || /^\s/.test(currentText);
    const boundaryFromWordFlag = prev?.isPartOfWord === false;
    const prevTrim = String(prev?.text || "").trim();
    const currentTrim = currentText.trim();
    const boundaryFromCensorship = isCensorshipBoundary(prevTrim, currentTrim);
    const boundaryFromHeuristic =
      typeof prev?.isPartOfWord !== "boolean" &&
      /[A-Za-z0-9]$/.test(text) &&
      /^[A-Za-z0-9]/.test(currentText);
    if (
      !hasWhitespaceBoundary &&
      (boundaryFromWordFlag || boundaryFromCensorship || boundaryFromHeuristic)
    ) {
      text += " ";
    }
    text += currentText;
  }
  return text.trim();
}

function serializeSyllables(syllables: LyricSyllable[]) {
  return JSON.stringify(
    syllables.map((syllable) => ({
      t: String(syllable.text || ""),
      s: Math.round(syllable.startTime),
      e: Math.round(syllable.endTime),
    })),
  );
}

function resolveDisplayLineIndex(positionMs: number, lyrics: LyricLine[]) {
  const activeIndex = findActiveLineIndex(positionMs, lyrics);
  if (activeIndex >= 0) {
    return activeIndex;
  }

  const previousIndex = findLastEndedLineIndex(positionMs, lyrics);
  if (previousIndex >= 0) {
    return previousIndex;
  }

  return findFirstUpcomingLineIndex(positionMs, lyrics);
}

export function resolveActiveLyricLine(
  lyrics: LyricLine[],
  positionMs: number,
): ActiveLyricLineSnapshot | null {
  if (!lyrics.length) {
    return null;
  }

  const lineIndex = resolveDisplayLineIndex(positionMs, lyrics);
  if (lineIndex < 0) {
    return null;
  }

  const line = lyrics[lineIndex];
  const text = getPrimaryLineText(line);
  if (!text) {
    return null;
  }

  return {
    text,
    lineStartMs: line.lineStartTime,
    lineEndMs: line.lineEndTime,
    syllablePayload: serializeSyllables(line.syllables || []),
  };
}

export function getActiveLyricLineKey(snapshot: ActiveLyricLineSnapshot | null) {
  if (!snapshot) {
    return "";
  }
  return `${snapshot.lineStartMs}:${snapshot.lineEndMs}:${snapshot.text}`;
}
