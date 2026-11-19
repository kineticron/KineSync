// Fail closed on the FINAL app image, link map, generated provider and compiled JS path.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { symbols } = require('./rust-device.cjs');
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function sourceMapSources(map) {
  function collect(node) {
    if (!node || typeof node !== 'object' || Array.isArray(node) || node.version !== 3) throw new Error('Malformed SourceMap v3');
    if ('sections' in node) {
      if (!Array.isArray(node.sections) || 'sources' in node || 'mappings' in node) throw new Error('Malformed indexed source map');
      return node.sections.flatMap(section => {
        if (!section || !section.offset || !Number.isInteger(section.offset.line) || section.offset.line < 0 ||
            !Number.isInteger(section.offset.column) || section.offset.column < 0 || 'url' in section || !section.map) throw new Error('Malformed indexed source map section');
        return collect(section.map);
      });
    }
    if (!Array.isArray(node.sources) || !node.sources.every(name => typeof name === 'string') ||
        typeof node.mappings !== 'string' || !Array.isArray(node.names) || !node.names.every(name => typeof name === 'string')) throw new Error('Malformed flat source map');
    return node.sources;
  }
  const sources = collect(map);
  if (!sources.length || !sources.some(name => name.length > 0)) throw new Error('Source map has no sources');
  return sources;
}
function prove({ app, executable, linkMap, ios, evidence }) {
  const nm = execFileSync('xcrun', ['nm', '-gU', path.join(app, executable)], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  const matched = {};
  for (const symbol of symbols) {
    const line = nm.split('\n').find(line => new RegExp(`\\b[Tt]\\s+_${symbol}$`).test(line));
    if (!line) throw new Error(`Final app Mach-O has no defined Rust symbol ${symbol}`);
    matched[symbol] = line.trim();
  }
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
  const bundle = path.join(evidence, 'rust-js-path.jsbundle');
  const sourcemap = path.join(evidence, 'rust-js-path.map');
  const source = fs.readFileSync(bundle, 'utf8');
  const sources = sourceMapSources(JSON.parse(fs.readFileSync(sourcemap, 'utf8')));
  if (!source.includes('KineSyncRustLyrics') || !source.includes('Try Rust renderer') || !sources.some(name => name.includes('rust-lyrics-view.tsx')) || !sources.some(name => name.includes('app/(tabs)/index.tsx'))) throw new Error('Compiled development JS does not contain player selection/native view path');
  const report = { app_image: path.join(app, executable), sha256: digest(path.join(app, executable)), symbols: matched,
    link_map: { sha256: digest(linkMap), static_archive: 'liblyrics_renderer.a' }, registrations,
    compiled_js: { bundle_sha256: digest(bundle), sourcemap_sha256: digest(sourcemap), selected_path: 'app/(tabs)/index.tsx -> RustLyricsView -> KineSyncRustLyrics' },
    note: 'Link and compiled path evidence, not a claim of launch, live Metro delivery or LiveContainer compatibility.' };
  fs.writeFileSync(path.join(evidence, 'rust-link-proof.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}
module.exports = { prove, sourceMapSources };
