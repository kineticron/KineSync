/**
 * Word grouping for the AMLL WebView.
 *
 * Spicy-sourced lyrics carry explicit `isPartOfWord` join flags with no
 * whitespace inside the syllable text (e.g. "Hel" + "lo" forming "Hello").
 * Other providers (KRC/QRC/YRC) encode boundaries in literal trailing spaces.
 * AMLL core joins its `words` array with no separator, so inter-word spacing
 * must live inside the word text itself.
 *
 * Flagged syllables are grouped by their join flags and a single separating
 * space is synthesized between groups (with punctuation/CJK awareness).
 * Unflagged syllables pass through 1:1 so literal spacing and per-syllable
 * timing are preserved exactly as before.
 */

import { repairSyllableClusters } from "./cluster-safe-syllables";

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
 * Build AMLL-core words from syllables. Flagged fragments are concatenated
 * into whole words with a synthesized separator; unflagged syllables map 1:1
 * with their text (and literal spaces) untouched.
 */
export function buildAmllWords(
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
    if (hasFlags && groupIndex < groups.length - 1) {
      const nextText = groups[groupIndex + 1]
        .map((syllable) => String(syllable.text || ""))
        .join("");
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
