import type { LyricLine } from "@/types/bridge";

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

/**
 * A line's text from its syllables, with each syllable's [start, end) range in
 * that text (UTF-16 offsets, after trimming, letters only). Spaces go between words: from
 * the syllable text itself, Spicy's isPartOfWord flag, or between letters.
 */
export function lyricTextWithRanges(syllables: LyricLine["syllables"]) {
  let text = "";
  const ranges: [number, number][] = [];
  (syllables || []).forEach((current, index) => {
    const currentText = String(current?.text || "");
    const prev = syllables[index - 1];
    if (index > 0 && currentText) {
      const hasWhitespaceBoundary = /\s$/.test(text) || /^\s/.test(currentText);
      const boundaryFromWordFlag = prev?.isPartOfWord === false;
      const boundaryFromCensorship = isCensorshipBoundary(String(prev?.text || "").trim(), currentText.trim());
      const boundaryFromHeuristic =
        typeof prev?.isPartOfWord !== "boolean" &&
        /[A-Za-z0-9]$/.test(text) &&
        /^[A-Za-z0-9]/.test(currentText);
      if (!hasWhitespaceBoundary && (boundaryFromWordFlag || boundaryFromCensorship || boundaryFromHeuristic)) {
        text += " ";
      }
    }
    // The range covers the letters only, not spaces around them.
    const start = text.length + (currentText.length - currentText.trimStart().length);
    text += currentText;
    ranges.push([start, Math.max(start, text.length - (currentText.length - currentText.trimEnd().length))]);
  });
  const lead = text.length - text.trimStart().length;
  const trimmed = text.trim();
  return {
    text: trimmed,
    ranges: ranges.map(([start, end]): [number, number] => [
      Math.max(0, Math.min(trimmed.length, start - lead)),
      Math.max(0, Math.min(trimmed.length, end - lead)),
    ]),
  };
}

export function getPrimaryLineText(line: LyricLine) {
  return lyricTextWithRanges(line.syllables || []).text;
}
