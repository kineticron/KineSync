/**
 * Guessed syllable splits, offline and free, one language at a time (the
 * Syllables menu has a language picker, so a mixed song is done language by
 * language). Each language only touches words in its own script. The result
 * is a first draft; every split can be fixed in the Syllables menu.
 *
 * English: the US English TeX hyphenation patterns (the `hyphen` package)
 * give dependable breaks; where they leave a chunk with more syllables than
 * breaks (they were made for typesetting, so "singing" or "tonight" stay
 * whole), spelling rules add the rest, up to the syllable count from the
 * `syllable` package.
 *
 * Spanish, Portuguese, French, Italian, German, Indonesian, Turkish, Polish
 * and Russian: their TeX hyphenation patterns (same package), which follow
 * syllables closely in these languages, plus one rule the typesetting
 * patterns leave out: a lone first vowel is its own syllable (a·mor).
 *
 * Hindi and Punjabi: Devanagari and Gurmukhi write syllables as letter units
 * (aksharas), so the splits fall between them, except where the inherent "a"
 * is not sung (schwa deletion): दिल stays whole, समझना is स·मझ·ना.
 *
 * Korean: every Hangul block is one syllable.
 */
import { hyphenateSync } from 'hyphen/en-us';
import { syllable } from 'syllable';
import { splitUnit, type StudioProject, wordGroups } from '@/lib/sync-studio/engine';
import { characters } from '@/lib/sync-studio/swipe';

// ---- English -------------------------------------------------------------------

const isVowelAt = (w: string, i: number) => 'aeiou'.includes(w[i]) || (w[i] === 'y' && i > 0);
/** Consonant pairs said together at the start of a syllable (to·geth·er) or kept at the end (sing·er). */
const ONSET_PAIRS = ['th', 'sh', 'ch', 'ph', 'wh', 'gh', 'qu', 'wr', 'kn'];
const CODA_PAIRS = ['ck', 'ng', 'nk'];

function vowelGroups(w: string) {
  const groups: { start: number; end: number }[] = [];
  for (let i = 0; i < w.length; i++) {
    if (!isVowelAt(w, i)) continue;
    const last = groups.at(-1);
    if (last && last.end === i) last.end = i + 1; else groups.push({ start: i, end: i + 1 });
  }
  // A final silent "e" (love, some), but not consonant + "le" (lit·tle).
  const last = groups.at(-1);
  if (groups.length > 1 && last && last.start === w.length - 1 && w.endsWith('e') && !(w.at(-2) === 'l' && !isVowelAt(w, w.length - 3))) groups.pop();
  return groups;
}

/** Spelling-rule break candidates in one chunk, best first. */
function ruleBreaks(w: string, wordEnd: boolean) {
  const groups = vowelGroups(w);
  const out: number[] = [];
  // -ing is its own syllable (sing·ing, cry·ing), unless that would split a consonant pair (thing).
  const stem = w.slice(0, -3);
  if (wordEnd && groups.length > 1 && w.endsWith('ing') && stem.length >= 2
    && !(/[^aeiouy]{2}$/.test(stem) && stem.at(-1) !== stem.at(-2))) out.push(w.length - 3);
  for (let i = 0; i + 1 < groups.length; i++) {
    const a = groups[i].end;
    const b = groups[i + 1].start;
    const between = w.slice(a, b);
    let at: number;
    if (i + 1 === groups.length - 1 && /^[^aeiouy]le$/.test(w.slice(b - 1))) at = Math.max(a, b - 2); // ta·ble, lit·tle
    else if (between.length === 1) at = between === 'x' ? b : a;                                         // to·night, a·bout
    else if (between.length === 2) at = ONSET_PAIRS.includes(between) ? a : CODA_PAIRS.includes(between) ? b : a + 1; // hap·py
    else at = ONSET_PAIRS.includes(between.slice(0, 2)) || CODA_PAIRS.includes(between.slice(0, 2)) ? a + 2 : a + 1;
    if (at > 0 && at < w.length && !out.includes(at)) out.push(at);
  }
  return out;
}

/** Break offsets (letters from the start) for a lowercase a–z word. */
export function englishBreaks(word: string): number[] {
  const w = word.toLowerCase();
  if (!/^[a-z]+$/.test(w) || w.length < 3) return [];
  const chunks = hyphenateSync(w, { hyphenChar: '­', minWordLength: 4 }).split('­');
  const breaks: number[] = [];
  let offset = 0;
  chunks.forEach((chunk, k) => {
    // Each chunk gets as many syllables as it is said with: some·body → body has two.
    const wanted = Math.max(1, syllable(chunk)) - 1;
    for (const at of ruleBreaks(chunk, k === chunks.length - 1).slice(0, wanted).sort((x, y) => x - y)) breaks.push(offset + at);
    offset += chunk.length;
    if (k < chunks.length - 1) breaks.push(offset);
  });
  return breaks.sort((x, y) => x - y);
}

// ---- Hindi and Punjabi (Devanagari, Gurmukhi) ------------------------------------

type Abugida = { letter: RegExp; independent: RegExp; sign: RegExp; virama: string; nasal: RegExp };
const DEVANAGARI: Abugida = {
  letter: /[ऀ-ॣ०-ॿ]/u,
  independent: /^[ऄ-औॠॡॲ-ॷ]/u,
  sign: /[ऺऻा-ौॎॏॕ-ॗॢॣ]/u,
  virama: '्',
  nasal: /[ँ-ः]/u,
};
const GURMUKHI: Abugida = {
  letter: /[ਁ-੣੦-੶]/u,
  // ੲ and ੳ carry a vowel sign as an independent vowel.
  independent: /^[ਅ-ਔੲੳ]/u,
  sign: /[ਾ-ੌ]/u,
  virama: '੍',
  // Bindi, tippi, visarga and addak (ੱ doubles the next consonant, closing this syllable).
  nasal: /[ਁ-ਃੰੱ]/u,
};

/**
 * Break offsets (letter units, as the slide bar counts them) for a word in an
 * abugida. Every akshara is a syllable unless its inherent "a" is dropped: at
 * the end of a word (दिल), or between two sung vowels as VC_CV (समझना: स·मझ·ना).
 */
function aksharaBreaks(word: string, script: Abugida): number[] {
  const units = characters(word);
  if (units.length < 2 || !units.every((unit) => script.letter.test(unit))) return [];
  // 'full': a vowel sign or independent vowel; 'a': the inherent vowel; 'none': ends in virama or dropped.
  const vowel = units.map((unit) => script.independent.test(unit) || script.sign.test(unit) ? 'full'
    : unit.endsWith(script.virama) ? 'none' : 'a');
  const conjunct = (unit: string) => unit.slice(0, -1).includes(script.virama);
  const last = units.length - 1;
  // Word-final "a" is not said (दिल, प्यार, इश्क़; ਦਿਲ).
  if (vowel[last] === 'a') vowel[last] = 'none';
  // Medial schwa deletion, right to left: V C(a) C V → V C C V.
  for (let k = last - 1; k >= 1; k--) {
    if (vowel[k] !== 'a' || conjunct(units[k]) || script.nasal.test(units[k])) continue;
    const next = units[k + 1];
    const nextSung = vowel[k + 1] !== 'none' && !script.independent.test(next) && !conjunct(next);
    if (vowel[k - 1] !== 'none' && nextSung) vowel[k] = 'none';
  }
  const breaks: number[] = [];
  // A unit that is sung starts a new syllable; one that is not joins the syllable before it.
  for (let k = 1; k < units.length; k++) if (vowel[k] !== 'none' && vowel.slice(0, k).some((v) => v !== 'none')) breaks.push(k);
  return breaks;
}

export const hindiBreaks = (word: string) => aksharaBreaks(word, DEVANAGARI);
export const punjabiBreaks = (word: string) => aksharaBreaks(word, GURMUKHI);

// ---- Pattern languages and Korean ------------------------------------------------

type Hyphenate = (text: string, options?: { hyphenChar?: string; minWordLength?: number }) => string;
/** Loaded on first use, so unused languages cost nothing at startup. */
/* eslint-disable @typescript-eslint/no-require-imports -- inline requires keep each language lazy */
const PATTERNS = {
  es: () => require('hyphen/es').hyphenateSync as Hyphenate,
  pt: () => require('hyphen/pt').hyphenateSync as Hyphenate,
  fr: () => require('hyphen/fr').hyphenateSync as Hyphenate,
  it: () => require('hyphen/it').hyphenateSync as Hyphenate,
  de: () => require('hyphen/de').hyphenateSync as Hyphenate,
  id: () => require('hyphen/id').hyphenateSync as Hyphenate,
  tr: () => require('hyphen/tr').hyphenateSync as Hyphenate,
  pl: () => require('hyphen/pl').hyphenateSync as Hyphenate,
  ru: () => require('hyphen/ru').hyphenateSync as Hyphenate,
};
/* eslint-enable @typescript-eslint/no-require-imports */
type PatternLanguage = keyof typeof PATTERNS;
const VOWELS = /[aeiouyáéíóúýàèìòùâêîôûãõäëïöüÿæœąęаеёиоуыэюяі]/iu;

/** Break offsets (UTF-16, in the word) from a language's hyphenation patterns. */
function patternBreaks(language: PatternLanguage, word: string) {
  const parts = PATTERNS[language]()(word, { hyphenChar: '­', minWordLength: 3 }).split('­');
  const breaks: number[] = [];
  let offset = 0;
  for (const part of parts.slice(0, -1)) { offset += part.length; breaks.push(offset); }
  // Typesetting never leaves one letter on a line, but a lone first vowel is a syllable: a·mor, a·mo·re.
  const lower = word.toLowerCase();
  if (lower.length >= 3 && VOWELS.test(lower[0]) && !VOWELS.test(lower[1]) && VOWELS.test(lower[2]) && /\p{L}/u.test(lower[1]) && !breaks.includes(1)) {
    breaks.unshift(1);
  }
  return breaks;
}

const HANGUL = /^[가-힣]$/u;

// ---- Applying ----------------------------------------------------------------------

export type SyllableLanguage = 'en' | PatternLanguage | 'hi' | 'pa' | 'ko';
export const SYLLABLE_LANGUAGES: { id: SyllableLanguage; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'es', label: 'Spanish · Español' },
  { id: 'pt', label: 'Portuguese · Português' },
  { id: 'fr', label: 'French · Français' },
  { id: 'it', label: 'Italian · Italiano' },
  { id: 'de', label: 'German · Deutsch' },
  { id: 'id', label: 'Indonesian / Malay' },
  { id: 'tr', label: 'Turkish · Türkçe' },
  { id: 'pl', label: 'Polish · Polski' },
  { id: 'ru', label: 'Russian · Русский' },
  { id: 'hi', label: 'Hindi · हिन्दी' },
  { id: 'pa', label: 'Punjabi · ਪੰਜਾਬੀ' },
  { id: 'ko', label: 'Korean · 한국어' },
];
export const syllableLanguageLabel = (id: SyllableLanguage) => SYLLABLE_LANGUAGES.find((entry) => entry.id === id)?.label ?? id;

/** The letters a language guesses on; everything else (other scripts, digits) is left alone. */
const SCRIPT: Record<SyllableLanguage, RegExp> = {
  en: /^[a-z]$/iu,
  es: /^\p{Script=Latin}\p{M}*$/u, pt: /^\p{Script=Latin}\p{M}*$/u, fr: /^\p{Script=Latin}\p{M}*$/u,
  it: /^\p{Script=Latin}\p{M}*$/u, de: /^\p{Script=Latin}\p{M}*$/u, id: /^\p{Script=Latin}\p{M}*$/u,
  tr: /^\p{Script=Latin}\p{M}*$/u, pl: /^\p{Script=Latin}\p{M}*$/u,
  ru: /^\p{Script=Cyrillic}\p{M}*$/u,
  hi: DEVANAGARI.letter, pa: GURMUKHI.letter, ko: HANGUL,
};

/**
 * Break offsets for one unit's text, in its letters (characters()), for one
 * language. Punctuation around the word is kept out; a word with letters of
 * another script is left alone.
 */
export function guessBreaks(text: string, language: SyllableLanguage = 'en'): number[] {
  const letters = characters(text);
  const isLetter = (unit: string) => SCRIPT[language].test(unit);
  const lead = letters.findIndex(isLetter);
  if (lead < 0) return [];
  let end = letters.length;
  while (end > lead && !isLetter(letters[end - 1])) end -= 1;
  const core = letters.slice(lead, end);
  // Apostrophes and hyphens may sit inside a word (baby's, aujourd'hui); anything else means it is not this language.
  if (!core.every((unit) => isLetter(unit) || /^['’-]$/u.test(unit))) return [];
  if (letters.slice(0, lead).some((unit) => /\p{L}/u.test(unit)) || letters.slice(end).some((unit) => /\p{L}/u.test(unit))) return [];
  let breaks: number[];
  if (language === 'hi') breaks = hindiBreaks(core.join(''));
  else if (language === 'pa') breaks = punjabiBreaks(core.join(''));
  else if (language === 'ko') breaks = core.map((_unit, i) => i).filter((i) => i > 0);
  else if (language === 'en') {
    // A contraction is guessed before its apostrophe (baby's → ba·by's).
    const word = /^[a-z]+/i.exec(core.join(''))?.[0] ?? '';
    breaks = englishBreaks(word);
  } else {
    // Patterns work in UTF-16 offsets; keep only those on a letter boundary.
    const word = core.join('');
    const boundaries = new Map<number, number>();
    core.reduce((offset, unit, i) => { boundaries.set(offset, i); return offset + unit.length; }, 0);
    breaks = patternBreaks(language, word).map((at) => boundaries.get(at)).filter((at): at is number => at != null && at > 0);
  }
  return breaks.map((at) => at + lead);
}

/**
 * "Guess syllables": split every word of the line that is not split yet, in
 * one language. Words you already split are left as they are. Returns how
 * many words changed.
 */
export function guessLineSyllables(project: StudioProject, index: number, language: SyllableLanguage = 'en') {
  const row = project.lines[index];
  if (!row || row.instrumental) return { project, words: 0 };
  let next = project;
  let words = 0;
  // Right to left, so splitting one word never moves the units of the words before it.
  for (const group of wordGroups(row).reverse()) {
    if (group.to !== group.from) continue;
    const breaks = guessBreaks(row.words[group.from].text, language);
    if (!breaks.length) continue;
    for (const at of [...breaks].reverse()) next = splitUnit(next, index, group.from, at);
    words += 1;
  }
  return { project: next, words };
}

/** "Guess syllables for the whole song": every line, leaving split words alone. */
export function guessSongSyllables(project: StudioProject, language: SyllableLanguage = 'en') {
  let next = project;
  let words = 0;
  project.lines.forEach((_row, index) => {
    const out = guessLineSyllables(next, index, language);
    next = out.project;
    words += out.words;
  });
  return { project: next, words };
}
