import type { LyricLine } from "@/types/bridge";

// Original demo lyrics, shared by both production renderers.
const phrases = [
  ["Follow the lyrics", "Suis les paroles"],
  ["Testing one two three", "Test un deux trois"],
  ["If you can read this it works", "Si vous pouvez le lire ça marche"],
  ["This is a cool app waow", "C'est un appli super waow"],
  [
    "Well I guess this song has to end",
    "Bon je suppose que cette chanson doit finir",
  ],
];
export const DEMO_LYRICS: LyricLine[] = phrases.map(
  ([text, translation], index) => {
    const start = index * 5000;
    const words = text.split(" ");
    return {
      lineStartTime: start,
      lineEndTime: start + 4600,
      syllables: words.map((word, i) => ({
        text: word + (i < words.length - 1 ? " " : ""),
        startTime: start + i * 650,
        endTime: i === words.length - 1 ? start + 4600 : start + (i + 1) * 650,
      })),
      translatedText: translation,
      ...(index === 1 || index === 3
        ? {
            backgroundSyllables: [
              {
                text: "Background lyrics",
                startTime: start + 1800,
                endTime: start + 4600,
              },
            ],
            backgroundTranslatedText: "Paroles de fond",
          }
        : {}),
      oppositeAligned: index === 3,
    };
  },
);


