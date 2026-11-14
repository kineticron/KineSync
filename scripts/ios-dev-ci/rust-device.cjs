const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const config = require('./config.json');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const symbols = ['kr_abi_version', 'kr_create', 'kr_set_track', 'kr_set_anchor', 'kr_resize', 'kr_render', 'kr_metrics', 'kr_destroy', 'kr_copy_error'];
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
  const root = process.env.RUST_PREBUILT_DIR;
  const framework = path.join(root, config.rust.framework);
  const checked = inspect(framework);
  const nm = inventory(checked.library);
  fs.writeFileSync(path.join(process.env.CI_EVIDENCE_DIR, 'rust-static-nm.txt'), nm);
  for (const symbol of symbols) if (!new RegExp(`\\b_${symbol}\\s*$`, 'm').test(nm)) throw new Error(`Static library missing ${symbol}`);
  const manifest = { cache_key: process.env.RUST_DEVICE_KEY, rust: config.rust, files: checked.files,
    rustc: execFileSync('rustc', [`+${config.rust.toolchain}`, '-vV'], { encoding: 'utf8' }), symbols };
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}
function validate() {
  const root = process.env.RUST_PREBUILT_DIR;
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
  if (manifest.cache_key !== process.env.RUST_DEVICE_KEY || JSON.stringify(manifest.rust) !== JSON.stringify(config.rust)) throw new Error('Cached Rust source/config identity mismatch');
  const checked = inspect(path.join(root, config.rust.framework));
  if (JSON.stringify(checked.files) !== JSON.stringify(manifest.files)) throw new Error('Rust XCFramework content/header integrity mismatch');
  const nm = inventory(checked.library);
  fs.writeFileSync(path.join(process.env.CI_EVIDENCE_DIR, 'rust-static-nm.txt'), nm);
  for (const symbol of symbols) if (!new RegExp(`\\b_${symbol}\\s*$`, 'm').test(nm)) throw new Error(`Cached library missing ${symbol}`);
  const destination = path.join(process.env.GITHUB_WORKSPACE, 'ExpoLyrics/modules/kinesync-rust-lyrics/ios/Frameworks');
  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(path.join(root, config.rust.framework), path.join(destination, config.rust.framework), { recursive: true, verbatimSymlinks: true });
  fs.copyFileSync(path.join(root, 'manifest.json'), path.join(process.env.CI_EVIDENCE_DIR, 'rust-device-manifest.json'));
}
if (require.main === module) {
  if (process.argv[2] === 'seal') seal();
  else if (process.argv[2] === 'validate') validate();
  else throw new Error('Expected seal or validate');
}
module.exports = { symbols, inspect, inventory };
