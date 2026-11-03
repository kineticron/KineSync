/**
 * Timed lyric segments and shaping-safe text groups for AMLL renderers.
 *
 * Spicy-sourced lyrics carry explicit `isPartOfWord` join flags with no
 * whitespace inside the syllable text (e.g. "Hel" + "lo" forming "Hello").
 * Other providers (KRC/QRC/YRC) encode boundaries in literal trailing spaces.
 * AMLL renderers join their `words` array with no separator, so inter-word
 * spacing must live inside the segment text itself.
 *
 * Join flags control spacing only in timed segments. Shaping consumers can
 * request whole groups separately, without changing animation timing.
 */

import { repairSyllableClusters } from "./cluster-safe-syllables";
import { getGraphemes } from "../../lib/graphemes";

export type AmllSyllable = {
  text?: string;
  startTime?: number;
  endTime?: number;
  isPartOfWord?: boolean;
};

export type AmllWord = {
  word: string;
  startTime: number;
  endTime: number;
  /** Excludes a synthesized trailing separator from timing interpolation. */
  timedGraphemeCount?: number;
};

function toFiniteMs(value: unknown, fallback = 0) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? Math.max(0, numberValue) : fallback;
}

// Chinese/Japanese text generally omits word spaces. Korean uses spaces
// between words, so Hangul must honor the provider's explicit boundaries.
const UNSPACED_CJK_CHAR_RE =
  /[぀-ヿ㐀-䶿一-鿿]/u;
const CENSOR_ONLY_RE = /^[*＊•·]+$/u;

// Standard closing punctuation that clings to the previous word (no space before it).
// Quotes and apostrophes are intentionally excluded from this character class so
// words leading with apostrophes ('cause, 'em, 'bout) or quotes are not misidentified.
const STANDARD_CLOSING_PUNCT_RE =
  /^[,.;:!?%)\]}»…，。、；：！？）】」』〉》]/u;

// Standalone closing quotes/brackets that are by themselves in a syllable.
const STANDALONE_CLOSING_QUOTE_RE = /^['’‘"”»›]+$/u;

// Suffix contractions that attach to the preceding word without a space.
// E.g. 's, 'm, 're, 've, 'll, 'd, 't, n't, 'clock, 'all.
const CONTRACTION_SUFFIX_RE =
  /^(['’‘](?:[mtsd]|re|ve|ll|clock|all)\b|n['’]t\b)/i;

// Prefix elisions that attach to the following word without a space.
// E.g. French/Italian: c', d', j', l', m', n', s', t', qu'
// English prefixes: o' (o'clock), y' (y'all)
const ELISION_PREFIX_RE =
  /^(?:[cdjlnst]|qu|[ouy]|all|dell|nell|sant)['’]$/i;

// Opening punctuation that is exclusively punctuation characters.
const OPENING_ONLY_PUNCT_RE =
  /^[[({«"“‘'¿¡«（【「『〈《]+$/u;

// True opening brackets that attach to the following word even if part of a token.
const TRUE_OPENING_BRACKET_RE = /[[({«¿¡«（【「『〈《]$/u;

function firstNonSpaceChar(text: string) {
  const trimmed = text.replace(/^\s+/u, "");
  return trimmed ? trimmed[0] : "";
}

function lastNonSpaceChar(text: string) {
  const trimmed = text.replace(/\s+$/u, "");
  return trimmed ? trimmed[trimmed.length - 1] : "";
}

export function needsSpaceBetweenGroups(currentText: string, nextText: string): boolean {
  if (!currentText || !nextText) {
    return false;
  }
  if (/[ \t\n]$/u.test(currentText) || /^[ \t\n]/u.test(nextText)) {
    return false;
  }
  const nextFirst = firstNonSpaceChar(nextText);
  const currentLast = lastNonSpaceChar(currentText);
  if (!nextFirst || !currentLast) {
    return false;
  }
  const currentTrimmed = currentText.trim();
  const nextTrimmed = nextText.trim();

  // Chinese/Japanese word boundaries take no space.
  if (UNSPACED_CJK_CHAR_RE.test(nextFirst) || UNSPACED_CJK_CHAR_RE.test(currentLast)) {
    return false;
  }

  // Censorship runs stay tight: "f***".
  if (CENSOR_ONLY_RE.test(nextTrimmed)) {
    return false;
  }

  // Standard closing punctuation attaches to the previous word: "Hello, world".
  if (STANDARD_CLOSING_PUNCT_RE.test(nextFirst)) {
    return false;
  }

  // Standalone closing quotes attach to the previous word: "Hello" + '"' -> 'Hello"'.
  if (STANDALONE_CLOSING_QUOTE_RE.test(nextTrimmed)) {
    return false;
  }

  // Contraction suffixes attach to the previous word: "It" + "'s" -> "It's".
  if (CONTRACTION_SUFFIX_RE.test(nextTrimmed)) {
    return false;
  }

  // Prefix elisions attach to the following word: "c'" + "est" -> "c'est", "o'" + "clock" -> "o'clock".
  if (ELISION_PREFIX_RE.test(currentTrimmed)) {
    return false;
  }

  // Standalone opening quotes/brackets attach to the next word: "(" + "Hello" -> "(Hello".
  if (OPENING_ONLY_PUNCT_RE.test(currentTrimmed)) {
    return false;
  }

  // Attached opening brackets cling to the next word: "feat.(" + "Coogie" -> "feat. (Coogie".
  if (TRUE_OPENING_BRACKET_RE.test(currentLast)) {
    return false;
  }

  // Attached hyphen clings to the following word: "well-" + "known" -> "well-known".
  if (currentTrimmed.length > 1 && /[-‐]$/u.test(currentTrimmed)) {
    return false;
  }

  return true;
}

/**
 * Group syllables into word clusters. Flagged lines follow `isPartOfWord`
 * (a `true` syllable joins to the next syllable); unflagged lines stay 1:1.
 */
export function groupAmllSyllables(
  syllables: AmllSyllable[],
): AmllSyllable[][] {
  if (!syllables.length) {
    return [];
  }
  const hasFlags = syllables.some(
    (syllable) => typeof syllable.isPartOfWord === "boolean",
  );
  if (!hasFlags) {
    return syllables.map((syllable) => [syllable]);
  }
  const groups: AmllSyllable[][] = [];
  let current: AmllSyllable[] = [];
  for (const syllable of syllables) {
    current.push(syllable);
    if (!syllable.isPartOfWord) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length) {
    groups.push(current);
  }
  return groups;
}

/**
 * Build animation items from syllables. Every safe provider timing atom stays
 * separate; word flags only determine synthetic spacing at group boundaries.
 */
export function buildAmllWords(
  syllables: AmllSyllable[],
  fallbackStart: number,
  fallbackEnd: number,
): AmllWord[] {
  return buildAmllTimedSegments(syllables, fallbackStart, fallbackEnd);
}

/** Whole text groups for renderers that need a single shaping/layout chunk. */
export function buildAmllShapingWords(
  syllables: AmllSyllable[],
  fallbackStart: number,
  fallbackEnd: number,
): AmllWord[] {
  const hasFlags = syllables.some((syllable) => typeof syllable.isPartOfWord === "boolean");
  const groups = groupAmllSyllables(repairSyllableClusters(syllables));
  const words: AmllWord[] = [];
  groups.forEach((group, groupIndex) => {
    const text = group
      .map((syllable, index) => {
        const raw = String(syllable.text || "");
        if (index < group.length - 1 && syllable.isPartOfWord) {
          return raw.replace(/\s+$/u, "");
        }
        return raw;
      })
      .join("");
    if (!text) {
      return;
    }
    const startTime = toFiniteMs(group[0]?.startTime, fallbackStart);
    const last = group[group.length - 1];
    const endTime = Math.max(
      startTime + 1,
      toFiniteMs(last?.endTime, fallbackEnd),
    );
    let word = text;
    if (hasFlags) {
      const nextText = groups.slice(groupIndex + 1)
        .map(nextGroup => nextGroup.map(syllable => String(syllable.text || "")).join(""))
        .find(text => text.length > 0) || "";
      if (
        !/[ \t\n]$/u.test(word) &&
        !/^[ \t\n]/u.test(nextText) &&
        needsSpaceBetweenGroups(word, nextText)
      ) {
        word += " ";
      }
    }
    words.push({ word, startTime, endTime });
  });
  if (words.length) {
    return words;
  }
  const fallbackStartMs = toFiniteMs(fallbackStart);
  return [
    {
      word: " ",
      startTime: fallbackStartMs,
      endTime: Math.max(fallbackStartMs + 1, toFiniteMs(fallbackEnd)),
    },
  ];
}

/**
 * Keep provider timing atoms intact while applying word-boundary spacing.
 */
function buildAmllTimedSegments(
  syllables: AmllSyllable[],
  fallbackStart: number,
  fallbackEnd: number,
): AmllWord[] {
  const repaired = repairSyllableClusters(syllables);
  const hasFlags = repaired.some((syllable) => typeof syllable.isPartOfWord === "boolean");
  const groups = groupAmllSyllables(repaired);
  const groupTexts = groups.map(group => group.map(part => String(part.text || "")).join(""));
  const segments: AmllWord[] = [];
  groups.forEach((group, groupIndex) => {
    const groupText = group.map((part, index) => {
      const raw = String(part.text || "");
      return index < group.length - 1 && part.isPartOfWord ? raw.replace(/\s+$/u, "") : raw;
    }).join("");
    const nextText = groupTexts.slice(groupIndex + 1).find(text => text.length > 0) ?? "";
    const addSpace = hasFlags &&
      !/[ \t\n]$/u.test(groupText) && !/^[ \t\n]/u.test(nextText) &&
      needsSpaceBetweenGroups(groupText, nextText);
    let lastTextIndex = -1;
    group.forEach((part, index) => {
      let word = String(part.text || "");
      if (index < group.length - 1 && part.isPartOfWord) word = word.replace(/\s+$/u, "");
      if (word) lastTextIndex = index;
    });
    group.forEach((part, index) => {
      let word = String(part.text || "");
      if (index < group.length - 1 && part.isPartOfWord) word = word.replace(/\s+$/u, "");
      if (!word) return;
      const addSeparator = addSpace && index === lastTextIndex;
      const timedGraphemeCount = addSeparator ? getGraphemes(word).length : undefined;
      if (addSeparator) word += " ";
      const startTime = toFiniteMs(part.startTime, fallbackStart);
      segments.push({
        word,
        startTime,
        endTime: Math.max(startTime + 1, toFiniteMs(part.endTime, fallbackEnd)),
        ...(timedGraphemeCount === undefined ? {} : { timedGraphemeCount }),
      });
    });
  });
  if (segments.length) return segments;
  const fallbackStartMs = toFiniteMs(fallbackStart);
  return [{ word: " ", startTime: fallbackStartMs, endTime: Math.max(fallbackStartMs + 1, toFiniteMs(fallbackEnd)) }];
}
