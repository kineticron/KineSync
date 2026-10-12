/* global __dirname */
// Copy the dependency's pure layout policy; DOM measurement is replaced by Skia.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const map = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/@applemusic-like-lyrics/core/dist/amll-core.mjs.map'), 'utf8'));
for (const [original, output] of [['utils/is-cjk.ts', 'amll-reference-is-cjk.ts'], ['utils/lyric-line-break.ts', 'amll-reference-line-break.ts'], ['utils/lyric-split-words.ts', 'amll-reference-word-split.ts']]) {
  const index = map.sources.findIndex(name => name.endsWith('/' + original));
  if (index < 0 || !map.sourcesContent[index]) throw new Error(`AMLL source missing: ${original}`);
  const source = map.sourcesContent[index].replace('"./is-cjk.ts"', '"./amll-reference-is-cjk"')
    .replace('import type { LyricWord } from "../interfaces.ts";', 'import type { AmllWord } from "../amll-word-spacing";\ntype LyricWord = AmllWord & { romanWord?: string; obscene?: boolean; ruby?: { word: string; startTime: number; endTime: number }[] };')
    .replace(/(type LyricWord = [^\n]+;)\n(import[^\n]+;)/, '$2\n$1')
    .replace('segmenter: Intl.Segmenter,', 'segmenter: { segment(input: string): Iterable<{ segment: string; isWordLike?: boolean }> },');
  const header = `// Generated from @applemusic-like-lyrics/core ${original} (AGPL-3.0-only).\n// Regenerate with node scripts/extract-amll-native-layout.cjs. Do not fit a different wrapping policy.\n`;
  fs.writeFileSync(path.join(root, 'components/lyrics/native', output), header + source);
}
console.log('Extracted the bundled AMLL pure line-balancing policy.');
