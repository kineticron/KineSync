/* Fetch actual provider lyrics for local typography checks. Lyrics are kept in
 * ignored .expo fixtures; committed regression tests use synthetic strings. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { probeLyricsSource } = require('../../DesktopBridge/src/lyrics');

// Use the production bridge parser when choosing a script-specific LRCLIB
// variant (the regular matcher can legitimately prefer a romanized upload).
const parserContext = vm.createContext({ Buffer,
  require: createRequire(path.resolve(__dirname, '../../DesktopBridge/src/lyricsService.js')) });
for (const file of ['01a-text-normalization.js', '01d-lyrics-parsing.js', '01e-utilities.js']) {
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../DesktopBridge/src/lyrics/parts', file), 'utf8'), parserContext);
}

async function fetchScriptVariant(track, script) {
  const url = 'https://lrclib.net/api/search?q=' + encodeURIComponent(track.title);
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`LRCLIB search HTTP ${response.status}`);
  const candidates = await response.json();
  const candidate = candidates.find(item => script.test(item.syncedLyrics || '')
    && String(item.artistName || '').toLowerCase().includes(track.artist.toLowerCase())
    && Math.abs(Number(item.duration) * 1000 - track.durationMs) < 5000);
  if (!candidate) return null;
  return { lyrics: parserContext.parseLrc(candidate.syncedLyrics), source: 'lrclib-script-variant',
    providerRecord: { id: candidate.id, trackName: candidate.trackName, artistName: candidate.artistName,
      duration: candidate.duration, searchUrl: url }, timingMode: 'interpolated' };
}

const tracks = [
  { language: 'thai', script: /\p{Script=Thai}/u, title: 'โต๊ะริม', artist: 'NONT TANONT', durationMs: 244000 },
  { language: 'hindi', script: /\p{Script=Devanagari}/u, title: 'Tum Hi Ho', artist: 'Arijit Singh', durationMs: 262000 },
  { language: 'telugu', script: /\p{Script=Telugu}/u, title: 'Inkem Inkem Inkem Kaavaale', artist: 'Sid Sriram', durationMs: 266000 },
];

async function main() {
  const directory = path.resolve(__dirname, '../.expo/cluster-lyrics');
  fs.mkdirSync(directory, { recursive: true });
  const results = await Promise.all(tracks.map(async ({ script, ...track }) => {
    for (const source of ['kugou', 'lrclib']) {
      const probe = await probeLyricsSource({ ...track, trackId: `cluster-${track.language}` }, source);
      let result = probe.result;
      if (source === 'lrclib' && !script.test((result?.lyrics || []).flatMap(line => line.syllables || []).map(part => part.text || '').join(''))) {
        result = await fetchScriptVariant(track, script);
      }
      const text = (result?.lyrics || []).flatMap(line => line.syllables || []).map(part => part.text || '').join('');
      if (result?.lyrics?.length && script.test(text)) {
        const fixture = { ...result, track, fetchedAt: new Date().toISOString() };
        fs.writeFileSync(path.join(directory, `${track.language}.json`), JSON.stringify(fixture, null, 2));
        const report = { ...track, source: result.source, lines: result.lyrics.length,
          tokens: result.lyrics.reduce((sum, line) => sum + (line.syllables?.length || 0), 0) };
        console.log(JSON.stringify(report));
        return report;
      }
      console.log(`${track.language}: ${source}: ${probe.errorMessage || (probe.ok ? 'lyrics are not in the requested script' : probe.errorType)}`);
    }
    throw new Error(`No ${track.language} script lyrics found for ${track.title}`);
  }));
  fs.writeFileSync(path.join(directory, 'fetch-report.json'), JSON.stringify(results, null, 2));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
