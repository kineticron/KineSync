import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { patchAmllScroll } from './amll-scroll-patch.mjs';

// AMLL 0.5.2 creates its own grapheme segmenter. Patch the build input rather
// than node_modules or global Intl: its word segmenter must remain untouched.
// Fail loudly on upstream changes instead of silently shipping unsafe text.
export function patchAmllClusters(source) {
  const replacements = [
    ['static graphemeSegmenter = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter(void 0, { granularity: "grapheme" }) : null;',
      'static graphemeSegmenter = { segment: graphemeSegments };'],
    ['word.word.trim().length <= 7 && word.word.trim().length > 1',
      'countGraphemes(word.word.trim()) <= 7 && word.word.trim().length > 1'],
    // Upstream's isCJK range also covers Thai and Indic scripts. Its earlier
    // word-splitting pass must be cluster-safe too, before emphasis is built.
    ['const chars = part.split("");', 'const chars = Array.from(splitGraphemes(part));'],
    ['endTime: startTime + timePerUnit,', 'endTime: startTime + timePerUnit * char.length,'],
    ['currentOffset += 1;', 'currentOffset += char.length;'],
  ];
  for (const [original, replacement] of replacements) {
    if (source.split(original).length !== 2) {
      throw new Error("AMLL cluster patch no longer matches upstream. Review its grapheme segmentation and emphasis eligibility before rebuilding.");
    }
    source = source.replace(original, replacement);
  }
  return 'import { graphemeSegments, splitGraphemes, countGraphemes } from "unicode-segmenter/grapheme";\n' + source;
}

export const amllClusterPlugin = {
  name: "amll-cluster-segmentation",
  setup(build) {
    let applied = false;
    build.onStart(() => { applied = false; });
    build.onLoad({ filter: /[/\\]@applemusic-like-lyrics[/\\]core[/\\]dist[/\\]amll-core\.mjs$/ }, async ({ path }) => {
      const contents = patchAmllScroll(patchAmllClusters(await readFile(path, "utf8")));
      applied = true;
      return { contents, loader: "js", resolveDir: dirname(path) };
    });
    build.onEnd((result) => {
      if (!applied && !result.errors.length) {
        return { errors: [{ text: "AMLL cluster patch was not loaded. Review the upstream entry point before shipping this bundle." }] };
      }
    });
  },
};
