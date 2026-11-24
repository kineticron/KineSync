'use strict';
/* global __dirname */

// Generate only the picker/provider sections owned by this change. Native shims
// and the remaining provider/parser sections keep their existing implementations.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const mobileFile = path.join(root, 'ExpoLyrics/lib/mobile-lyrics-service.js');
const parts = ['03-qq-sources.js', '04-netease-spicy-lrclib-sources.js', '04-kugou-source.js',
  '04-lrc-red-source.js', '07a-source-scoring.js', '07b-service-orchestration.js'];
function generate(input) {
  let output = input;
  for (const name of parts) {
    const marker = `// ---- DesktopBridge/src/lyrics/parts/${name} ----`;
    const at = output.indexOf(marker);
    if (at < 0 || output.indexOf(marker, at + marker.length) >= 0) throw new Error(`Expected one ${name} section`);
    const start = at + marker.length;
    let end = output.indexOf('\n// ---- DesktopBridge/src/lyrics/parts/', start);
    if (end < 0) end = output.indexOf('\nexport {', start);
    if (end < 0) throw new Error(`Missing end of ${name}`);
    let source = fs.readFileSync(path.join(root, 'DesktopBridge/src/lyrics/parts', name), 'utf8').replace(/^"use strict";\s*/, '').trim();
    source = source.replaceAll('require("./lyricsRecordingIdentity")', 'require("../../DesktopBridge/src/lyricsRecordingIdentity")');
    source = source.replaceAll('require("./lyricsAutoPicker")', 'require("../../DesktopBridge/src/lyricsAutoPicker")')
      .replaceAll('require("./lyricsTtmlTranslations")', 'require("../../DesktopBridge/src/lyricsTtmlTranslations")');
    if (name === '04-lrc-red-source.js') {
      source = '"use strict";\n\n' + source.replaceAll(
        'const { parseTtmlToLyrics, parseTtmlTimeExpression, extractTtmlMetadata } = require("./lyricsTtmlImport");',
        `const parseTtmlToLyrics = parseLrcRedTtml;
  const parseTtmlTimeExpression = parseLrcRedTime;
  const extractTtmlMetadata = extractLrcRedTtmlMetadata;`,
      ).replace(
        '        const content = await fetchText(`https://lrc.red/s/${candidate.isrc}.ttml`, { headers: lrcRedHeaders });',
        `        const tracePacket = {};
        const trace = typeof __DEV__ !== 'undefined' && __DEV__ ? beginArrival(tracePacket, 'lrc-red') : undefined;
        const content = await fetchText(\`https://lrc.red/s/\${candidate.isrc}.ttml\`, { headers: lrcRedHeaders, arrivalTrace: trace });`,
      ).replace(
        '        const parsed = parseTtmlToLyrics(content);',
        `        const parsed = trace ? arrivalSpan(trace, 0, 'parser', () => parseTtmlToLyrics(content)) : parseTtmlToLyrics(content);
        if (trace && parsed.lyrics) linkArrival(parsed.lyrics, trace);`,
      );
    }
    if (name === '07b-service-orchestration.js') {
      source = source.replaceAll('|desktop', '|mobile').replaceAll('desktop-bridge', 'mobile-app').replaceAll('on desktop.', 'on mobile.')
        .replaceAll('require("./lyricsVault")', 'mobileLyricsVaultShim').replaceAll('require("./lyricsTtmlImport")', 'mobileTtmlImportShim')
        .replace('    getCachedSourceLyricsPacket,', '    getCachedSourceLyricsPacket,\n    resolveSpotifyCatalogTrackById,\n    resolveSpotifyCatalogTrackViaPartnerSearch,\n    buildLyricsMatchTrack,\n    mergeNativePlaybackArtist,\n    applySpotifyCatalogOverlay,');
      source = source.replace('      const parsed = parseTtmlToLyrics(ttmlContent);', `      const tracePacket = {};
      const trace = typeof __DEV__ !== 'undefined' && __DEV__ ? beginArrival(tracePacket, 'vault-ttml-import') : undefined;
      if (trace) arrivalEvent(trace, 0, 'import-input-rn-received');
      const parsed = trace ? arrivalSpan(trace, 0, 'parser', () => parseTtmlToLyrics(ttmlContent)) : parseTtmlToLyrics(ttmlContent);
      if (trace && parsed.lyrics) linkArrival(parsed.lyrics, trace);`);
    }
    output = output.slice(0, start) + '\n' + source + '\n' + output.slice(end);
  }
  return output;
}
if (require.main === module) {
  const current = fs.readFileSync(mobileFile, 'utf8');
  const output = generate(current);
  if (process.argv.includes('--check')) {
    if (output !== current) throw new Error('Mobile picker/provider sections are stale');
    console.log('Mobile picker/provider sections match shared sources.');
  } else fs.writeFileSync(mobileFile, output);
}
module.exports = { generate };
