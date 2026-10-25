"use strict";
// Opt-in live comparison. Requests run sequentially with a 600 ms delay.
// Usage: node DesktopBridge/scripts/compare-lrc-red-live.cjs baseline
// Then: node DesktopBridge/scripts/compare-lrc-red-live.cjs final [Spotify IDs...]
// Baseline saves Spotify metadata and Spicy responses. Later stages reuse those
// responses and only repeat the selected lrc.red lookups against the network.
// Raw responses stay in LRC_RED_AUDIT_DIR, outside the repository by default.
// The configured publishable key is read locally and never written to the trace.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const { createRequire } = require('node:module'), { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
process.chdir(root);
const dir = process.env.LRC_RED_AUDIT_DIR || path.join(require('node:os').tmpdir(), 'kinesync-lrcred-audit');
fs.mkdirSync(dir, { recursive: true });
const songs = [['ew', 'DPR CREAM', '6dfJecdkrYg19hefBy4kts'], ['후 (puff)', 'DPR CREAM', '0MmlAwSg3Zx8590JMei6G9'], ['Rewind', 'Wonder Girls', '2YZa0dsV3xXGZ61XFYiRt8'], ['Dynamite', '방탄소년단', '5QDLhrAOJJdNAmCTJ8xMyW'], ['アイドル', 'YOASOBI', '1hAloWiinXLPQUJxrJReb1'], ['First Love', '宇多田ヒカル', '39HrUxcvKF3jtLz7fUDWXc'], ['DtMF', 'Bad Bunny', '3sK8wGT43QFpWrvNQsrQya'], ['Yesterday - Remastered 2009', 'The Beatles', '3BQHpFgAp4l80e1XslIjNI'], ['Bohemian Rhapsody - Live Aid', 'Queen', '7xHATAMD7ezTZGYsNAMr5R'], ['Billie Jean', 'Michael Jackson', '1Rt3oh7shVSWj6q2MieDHa']];
const stage = process.argv[2] || 'baseline', selected = process.argv.slice(3);
let seq = 0, trace = [], current = '';
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
async function live(url, options = {}) {
    await new Promise(r => setTimeout(r, 600));
    const start = new Date().toISOString(), id = `${stage}-${String(++seq).padStart(3, '0')}`;
    try {
        const response = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(30000) }), body = await response.clone().text();
        fs.writeFileSync(`${dir}/${id}.body`, body);
        trace.push({ id, song: current, start, url: String(url), status: response.status, bytes: Buffer.byteLength(body), sha256: hash(body), userAgent: options.headers?.['User-Agent'], bodyFile: `${id}.body` });
        fs.writeFileSync(`${dir}/${stage}-trace.json`, JSON.stringify(trace, null, 2));
        return response;
    }
    catch (e) {
        trace.push({ id, song: current, start, url: String(url), error: e.message });
        throw e;
    }
}
function context() {
    const req = createRequire(path.join(root, 'DesktopBridge/src/lyricsService.js'));
    const c = vm.createContext({ AbortController, Buffer, clearTimeout, setTimeout, clearInterval, setInterval, TextDecoder, URL, URLSearchParams, console, fetch: live, global: {}, module: { exports: {} }, process: { env: {} }, require: stage === 'baseline' ? p => p === './lyricsTtmlImport' ? require(`${dir}/baseline-import.cjs`) : req(p) : req });
    const index = fs.readFileSync('DesktopBridge/src/lyrics/index.js', 'utf8');
    for (const m of index.match(/const partFiles = \[([\s\S]*?)\];/)[1].matchAll(/"([^"]+)"/g)) {
        const file = 'DesktopBridge/src/lyrics/parts/' + m[1];
        let src = stage === 'baseline' ? execFileSync('git', ['show', '98f9195:' + file], { encoding: 'utf8' }) : fs.readFileSync(file, 'utf8');
        vm.runInContext(src, c);
    }
    return c;
}
(async () => {
    if (stage === 'baseline')
        fs.writeFileSync(`${dir}/baseline-import.cjs`, execFileSync('git', ['show', '98f9195:DesktopBridge/src/lyricsTtmlImport.js']));
    let out = [];
    for (const [title, artist, spotifyId] of songs) {
        if (selected.length && !selected.includes(spotifyId))
            continue;
        current = title;
        const c = context();
        let entity;
        if (stage === 'baseline') {
            const html = await (await live(`https://open.spotify.com/embed/track/${spotifyId}`, { headers: { 'User-Agent': 'KineSync' } })).text();
            entity = JSON.parse(html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s)[1]).props.pageProps.state.data.entity;
            fs.writeFileSync(`${dir}/metadata-${spotifyId}.json`, JSON.stringify(entity, null, 2));
        }
        else
            entity = require(`${dir}/metadata-${spotifyId}.json`);
        const track = { title, artist, durationMs: entity.duration };
        c.track = track;
        let result, error;
        try {
            result = await vm.runInContext('fetchFromLrcRed(track)', c);
        }
        catch (e) {
            error = e.message;
        }
        let spicy;
        if (stage === 'baseline') {
            const key = require(path.join(root, 'DesktopBridge/src/spicyLyricsConfig.json')).publishableKey;
            const r = await live(`https://api.spicylyrics.org/v1/lyrics/${spotifyId}`, { headers: { Authorization: `Bearer ${key}`, 'User-Agent': 'KineSync' } });
            spicy = await r.json();
            fs.writeFileSync(`${dir}/spicy-${spotifyId}.json`, JSON.stringify(spicy, null, 2));
        }
        else
            spicy = require(`${dir}/spicy-${spotifyId}.json`);
        c.payload = spicy.Body;
        c.duration = entity.duration;
        const spicyLines = vm.runInContext('parseSpicyLyrics(payload,duration)', c);
        const row = { track, spotifyId, spotify: { title: entity.title, artists: entity.artists, releaseDate: entity.releaseDate }, error, lrc: result ? { source: result.source, isrc: result.metadata.attribution.url.split('/').pop(), lyrics: result.lyrics } : null, spicy: { Status: spicy.Status, source: spicy.Body?.source, source_via: spicy.Body?.source_via, Type: spicy.Body?.Type, lyrics: spicyLines } };
        out.push(row);
        fs.writeFileSync(`${dir}/${stage}-results.json`, JSON.stringify(out, null, 2));
        console.log(JSON.stringify({ title, artist, duration: entity.duration, error, lrc: row.lrc && [row.lrc.isrc, row.lrc.source, row.lrc.lyrics.length], spicy: [row.spicy.Status, row.spicy.source, row.spicy.source_via, row.spicy.Type, spicyLines.length] }));
    }
})().catch(e => { console.error(e); process.exitCode = 1; });
