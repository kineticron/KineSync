// Fail closed on the final simulator app image, link map, provider and embedded JS.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { symbols, inspectFonts } = require('./rust-sim.cjs');
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
// Expo native module name, ABI method, native view input and playback command.
const JS_MARKERS = ['KineSyncRustLyrics', 'abiVersion', 'trackJson', 'setAnchor'];
function missingJsMarkers(data) {
  return JS_MARKERS.filter(marker => !data.includes(Buffer.from(marker, 'utf8')) && !data.includes(Buffer.from(marker, 'utf16le')));
}
function findJsBundles(app) {
  const found = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith('.jsbundle')) found.push(file);
    }
  }
  walk(app);
  if (!found.length) throw new Error('No embedded .jsbundle in final app');
  return found;
}
function linkedArchive(map, expectedLibrary) {
  const members = [...map.matchAll(/^\[\s*(\d+)\]\s+(.+liblyrics_renderer\.a)\([^\n]+\)\s*$/gm)];
  if (!members.length) throw new Error('Link map has no Rust archive members');
  const paths = [...new Set(members.map(match => match[2]))];
  if (paths.length !== 1 || !path.isAbsolute(paths[0]) || digest(paths[0]) !== digest(expectedLibrary)) throw new Error('Linked archive differs from source-exact simulator archive');
  const render = map.match(/^0x[0-9A-Fa-f]+\s+0x[0-9A-Fa-f]+\s+\[\s*(\d+)\]\s+_kr_render\s*$/m);
  if (!render || !members.some(match => Number(match[1]) === Number(render[1]))) throw new Error('kr_render is not attributed to the validated Rust archive');
  return { path: paths[0], sha256: digest(paths[0]) };
}
function prove({ app, executable, linkMap, ios, evidence }) {
  const nm = execFileSync('xcrun', ['nm', '-gU', path.join(app, executable)], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  const matched = {};
  for (const symbol of symbols) {
    const line = nm.split('\n').find(line => new RegExp(`\\b[Tt]\\s+_${symbol}$`).test(line));
    if (!line) throw new Error(`Final simulator app Mach-O has no defined Rust symbol ${symbol}`);
    matched[symbol] = line.trim();
  }
  if (!fs.existsSync(linkMap)) throw new Error(`Missing link map: ${linkMap}`);
  const map = fs.readFileSync(linkMap, 'utf8');
  if (!/liblyrics_renderer\.a/.test(map) || !/_kr_render\b/.test(map)) throw new Error('App link map does not prove Rust static archive and render symbol inclusion');
  const providers = [];
  const support = path.join(ios, 'Pods/Target Support Files');
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name === 'ExpoModulesProvider.swift' && /KineSyncRustLyricsModule\.self/.test(fs.readFileSync(file, 'utf8'))) providers.push(file);
    }
  }
  walk(support);
  if (!providers.length) throw new Error('Generated ExpoModulesProvider has no Rust module registration');
  fs.copyFileSync(linkMap, path.join(evidence, 'app-rust-LinkMap.txt'));
  const registrations = providers.map((file, index) => {
    fs.copyFileSync(file, path.join(evidence, `ExpoModulesProvider-${index}.swift`));
    return { path: file, sha256: digest(file) };
  });
  const bundles = findJsBundles(app).map((file, index) => {
    const missing = missingJsMarkers(fs.readFileSync(file));
    if (missing.length) throw new Error(`Embedded JS ${file} lacks ${missing.join(', ')}`);
    const copy = path.join(evidence, `app-embedded-${index}-${path.basename(file)}`);
    fs.copyFileSync(file, copy);
    return { path: path.relative(app, file), sha256: digest(file), bytes: fs.statSync(file).size, markers: JS_MARKERS, evidence: copy };
  });
  const manifest = JSON.parse(fs.readFileSync(path.join(evidence, 'rust-sim-manifest.json')));
  const { inspect } = require('./rust-sim.cjs');
  const framework = path.join(ios, '../modules/kinesync-rust-lyrics/ios/Frameworks/KineSyncLyrics.xcframework');
  const checked = inspect(framework);
  if (JSON.stringify(checked.files) !== JSON.stringify(manifest.files)) throw new Error('Linked framework differs from source-exact validated framework');
  const archiveName = path.basename(checked.library);
  const linked = linkedArchive(map, checked.library);
  const font_resources = inspectFonts(app);
  const report = { font_resources, app_image: path.join(app, executable), sha256: digest(path.join(app, executable)), symbols: matched,
    link_map: { sha256: digest(linkMap), static_archive: archiveName, linked_archive: linked, validated_framework_files: checked.files, source_cache_key: manifest.cache_key }, registrations,
    embedded_js: bundles,
    note: 'Link and embedded-bundle evidence, not a claim that the Rust view rendered. Onboarding smoke proves app startup only.' };
  fs.writeFileSync(path.join(evidence, 'rust-link-proof.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}
module.exports = { prove, findJsBundles, JS_MARKERS, missingJsMarkers, linkedArchive };
