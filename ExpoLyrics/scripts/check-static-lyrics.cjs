const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const renderer = path.resolve(__dirname, '../components/lyrics/rust');
const read = file => readFileSync(path.join(renderer, file), 'utf8');
const staticView = read('static-lyrics-view.tsx');
const rustView = read('rust-lyrics-view.tsx');

assert.match(staticView, /<ScrollView\b/);
assert.match(staticView, /<Text\b/);
assert.match(rustView, /from ['"]\.\/static-lyrics-view['"]/);
assert.match(rustView, /showStaticLyrics\s*=\s*useMemo\(\(\)\s*=>\s*untimed\s*&&\s*rawLyrics\.some\(getStaticLineText\)/);
assert.match(rustView, /if \(showStaticLyrics\) \{\s*return <StaticLyricsView\b/);
