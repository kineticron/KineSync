const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const config = require('./config.json');
function effectiveRust(buildConfig = config, kind = process.env.KINESYNC_IOS_BUILD_KIND ?? 'release') {
  if (kind !== 'release' && kind !== 'development') throw new Error('Invalid KINESYNC_IOS_BUILD_KIND');
  for (const feature of ['dev-frame-trace', 'dev-render-metrics']) {
    if (buildConfig.rust.features.includes(feature)) throw new Error(`${feature} must be development-only`);
  }
  return { ...buildConfig.rust, features: kind === 'development'
    ? [...new Set([...buildConfig.rust.features, ...buildConfig.developmentRustFeatures])]
    : buildConfig.rust.features };
}
function validateRustIdentity(manifest, cacheKey, rust) {
  if (!cacheKey || manifest.cache_key !== cacheKey || JSON.stringify(manifest.rust) !== JSON.stringify(rust)) {
    throw new Error('Cached Rust source/config identity mismatch');
  }
}
function validateTraceMarker(nm, rust) {
  const trace = rust.features.includes('dev-frame-trace');
  const metrics = trace || rust.features.includes('dev-render-metrics');
  if (/\b_kr_frame_trace_build_marker\s*$/m.test(nm) !== trace) {
    throw new Error('Static library trace feature mismatch');
  }
  if (/\b_kr_render_metrics_build_marker\s*$/m.test(nm) !== metrics) {
    throw new Error('Static library metrics feature mismatch');
  }
}
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const symbols = ['kr_abi_version', 'kr_create', 'kr_set_fonts', 'kr_copy_layout_json', 'kr_set_track', 'kr_set_anchor', 'kr_resize', 'kr_set_following', 'kr_scroll_by', 'kr_fling', 'kr_hit_test', 'kr_render', 'kr_metrics', 'kr_destroy', 'kr_copy_error'];
function inspect(framework) {
  const info = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', path.join(framework, 'Info.plist')], { encoding: 'utf8' }));
  if (info.AvailableLibraries?.length !== 1) throw new Error('Expected one device-only XCFramework slice');
  const slice = info.AvailableLibraries[0];
  if (slice.SupportedPlatform !== 'ios' || slice.SupportedPlatformVariant || JSON.stringify(slice.SupportedArchitectures) !== '["arm64"]') throw new Error('Unexpected simulator/non-arm64 XCFramework');
  for (const key of ['LibraryIdentifier', 'LibraryPath', 'HeadersPath']) {
    if (!slice[key] || path.isAbsolute(slice[key]) || slice[key].split('/').includes('..')) throw new Error('Invalid XCFramework path');
  }
  const root = path.join(framework, slice.LibraryIdentifier);
  const library = path.join(root, slice.LibraryPath);
  const header = path.join(root, slice.HeadersPath, 'KineSyncLyrics.h');
  const modulemap = path.join(root, slice.HeadersPath, 'module.modulemap');
  const arch = execFileSync('xcrun', ['lipo', '-archs', library], { encoding: 'utf8' }).trim();
  if (arch !== 'arm64') throw new Error(`Static library has unexpected architecture: ${arch}`);
  if (!fs.readFileSync(modulemap, 'utf8').includes('module KineSyncLyrics')) throw new Error('Missing Swift Clang module map');
  return { slice, library, files: Object.fromEntries([library, header, modulemap, path.join(framework, 'Info.plist')].map(file => [path.relative(framework, file), hash(file)])) };
}
// Prove actual packaged resources match the existing source assets, not just podspec text.
function inspectFonts(app, sourceRoot = path.resolve(__dirname, '../..')) {
  const bundles = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'KineSyncLyricsFonts.bundle') bundles.push(file);
        else walk(file);
      }
    }
  }
  walk(app);
  if (bundles.length !== 1) throw new Error('Expected exactly one packaged Rust font bundle');
  const files = {};
  for (const name of ['SF-Pro-Display-Regular.otf', 'SF-Pro-Display-Bold.otf']) {
    const file = path.join(bundles[0], name);
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error(`Missing packaged Rust font ${name}`);
    const expected = hash(path.join(sourceRoot, 'ExpoLyrics/assets/fonts', name));
    if (hash(file) !== expected) throw new Error(`Packaged Rust font digest mismatch: ${name}`);
    files[path.relative(app, file)] = expected;
  }
  return files;
}
// Rust archives include bundled std bitcode; Apple's older LLVM reader may reject it.
function inventory(library) {
  const rustcArgs = [`+${config.rust.toolchain}`];
  const sysroot = execFileSync('rustc', [...rustcArgs, '--print', 'sysroot'], { encoding: 'utf8' }).trim();
  const version = execFileSync('rustc', [...rustcArgs, '-vV'], { encoding: 'utf8' });
  const host = version.match(/^host: (\S+)$/m)?.[1];
  if (!host || !path.isAbsolute(sysroot)) throw new Error('Invalid pinned Rust sysroot/host');
  const reader = path.join(sysroot, 'lib/rustlib', host, 'bin/llvm-nm');
  // execFileSync must succeed before any inventory can be accepted or written.
  return execFileSync(reader, ['--extern-only', '--defined-only', library], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
}
function seal() {
  const rust = effectiveRust();
  const root = process.env.RUST_PREBUILT_DIR;
  const framework = path.join(root, config.rust.framework);
  const checked = inspect(framework);
  const nm = inventory(checked.library);
  fs.writeFileSync(path.join(process.env.CI_EVIDENCE_DIR, 'rust-static-nm.txt'), nm);
  for (const symbol of symbols) if (!new RegExp(`\\b_${symbol}\\s*$`, 'm').test(nm)) throw new Error(`Static library missing ${symbol}`);
  validateTraceMarker(nm, rust);
  const manifest = { cache_key: process.env.RUST_DEVICE_KEY, rust, files: checked.files,
    rustc: execFileSync('rustc', [`+${config.rust.toolchain}`, '-vV'], { encoding: 'utf8' }), symbols };
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}
function validate() {
  const rust = effectiveRust();
  const root = process.env.RUST_PREBUILT_DIR;
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
  validateRustIdentity(manifest, process.env.RUST_DEVICE_KEY, rust);
  const checked = inspect(path.join(root, config.rust.framework));
  if (JSON.stringify(checked.files) !== JSON.stringify(manifest.files)) throw new Error('Rust XCFramework content/header integrity mismatch');
  const nm = inventory(checked.library);
  fs.writeFileSync(path.join(process.env.CI_EVIDENCE_DIR, 'rust-static-nm.txt'), nm);
  for (const symbol of symbols) if (!new RegExp(`\\b_${symbol}\\s*$`, 'm').test(nm)) throw new Error(`Cached library missing ${symbol}`);
  const destination = path.join(process.env.GITHUB_WORKSPACE, 'ExpoLyrics/modules/kinesync-rust-lyrics/ios/Frameworks');
  validateTraceMarker(nm, rust);
  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(path.join(root, config.rust.framework), path.join(destination, config.rust.framework), { recursive: true, verbatimSymlinks: true });
  fs.copyFileSync(path.join(root, 'manifest.json'), path.join(process.env.CI_EVIDENCE_DIR, 'rust-device-manifest.json'));
}
if (require.main === module) {
  if (process.argv[2] === 'seal') seal();
  else if (process.argv[2] === 'validate') validate();
  else throw new Error('Expected seal or validate');
}
// Release can dead-strip diagnostics that are only called in Debug.
const releaseSymbols = symbols.filter(symbol => symbol !== 'kr_copy_layout_json' && symbol !== 'kr_copy_error');

module.exports = { symbols, releaseSymbols, inspect, inventory, inspectFonts, effectiveRust, validateRustIdentity };
