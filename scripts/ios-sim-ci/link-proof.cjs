// Fail closed on the final simulator app image, link map, provider and embedded JS.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { symbols, inspectFonts } = require('./rust-sim.cjs');
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const JS_MARKERS = ['KineSync', 'kinesync_use_rust_renderer', 'Use experimental Rust lyrics renderer', 'RustLyricsView'];
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
    const text = fs.readFileSync(file, 'utf8');
    const missing = JS_MARKERS.filter(marker => !text.includes(marker));
    if (missing.length) throw new Error(`Embedded JS ${file} lacks ${missing.join(', ')}`);
    const copy = path.join(evidence, `app-embedded-${index}-${path.basename(file)}`);
    fs.copyFileSync(file, copy);
    return { path: path.relative(app, file), sha256: digest(file), bytes: fs.statSync(file).size, markers: JS_MARKERS, evidence: copy };
  });
  const font_resources = inspectFonts(app);
  const report = { font_resources, app_image: path.join(app, executable), sha256: digest(path.join(app, executable)), symbols: matched,
    link_map: { sha256: digest(linkMap), static_archive: 'liblyrics_renderer.a' }, registrations,
    embedded_js: bundles,
    note: 'Link and embedded-bundle evidence, not a claim that the Rust view rendered. Onboarding smoke proves app startup only.' };
  fs.writeFileSync(path.join(evidence, 'rust-link-proof.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}
module.exports = { prove, findJsBundles, JS_MARKERS };
