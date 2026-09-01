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
