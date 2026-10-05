/** Spicy supplies join flags; KRC/QRC/YRC encode their boundaries in the text. */
export function getSpicyWordJoins(syllables: { text?: string; isPartOfWord?: boolean }[]) {
  return syllables.map((syllable, index) => {
    if (typeof syllable.isPartOfWord === "boolean") return syllable.isPartOfWord;
    const next = syllables[index + 1];
    return Boolean(next && !/\s$/u.test(syllable.text || "") && !/^\s/u.test(next.text || ""));
  });
}
